/* ─────────────────────────────────────────────
   选餐 · 采集器核心（唯一真源）
   ─────────────────────────────────────────────

   这个文件被两条交付路径共用，改这里两边都会生效：

     1. 油猴脚本（用户自己装 Tampermonkey）
        collector/meal-picker-collector.user.js
     2. 中继托管浏览器直接注入（用户什么都不用装）
        relay 通过 CDP 把它注入到平台页面的 document_start

   两条路径的差别只有两处，都做了运行时判定：

     · 与中继通信：油猴里有 GM_xmlhttpRequest 就用它（不受同源限制），
       注入版没有，就用普通 fetch —— 中继对所有来源都回了
       Access-Control-Allow-Origin: *，并且处理了 OPTIONS 预检。
     · 嗅探钩子的安装位置：油猴脚本跑在隔离世界，包不到页面真正的
       fetch，所以要把代码插进 <script> 走主世界；注入版本来就在主世界，
       直接包即可。

   约定：__RELAY_PORT__ 由打包脚本 / 中继替换成真实端口。
   ───────────────────────────────────────────── */

function __mealPickerCollectorCore() {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     0. 基本设定
     ══════════════════════════════════════════════════════════ */

  const RELAY_PORT = __RELAY_PORT__;
  const RELAY = `http://127.0.0.1:${RELAY_PORT}`;
  const VERSION = '2.1.1';
  const LOG = (...a) => console.log('%c[选餐采集]', 'color:#FF8A3D;font-weight:700', ...a);

  /** 当前平台判定 */
  function detectPlatform() {
    const h = location.hostname;
    if (/meituan\.com$/.test(h)) return 'meituan';
    if (/ele\.me$/.test(h)) return 'eleme';
    if (/taobao\.com$|tmall\.com$/.test(h)) return 'taobao';
    if (/jd\.com$/.test(h)) return 'jd';
    return null;
  }
  const PLATFORM = detectPlatform();
  if (!PLATFORM) return;

  /** 关键词：优先取 URL 上的，其次取输入框里的 */
  function currentKeyword() {
    const u = new URL(location.href);
    for (const k of ['keyword', 'q', 'kw', 'query', 'wq', 'search', 'word']) {
      const v = u.searchParams.get(k);
      if (v && v.trim()) return v.trim();
    }
    const hash = location.hash || '';
    const m = hash.match(/(?:keyword|q|kw)=([^&]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch { /* ignore */ } }
    for (const sel of ['input[type=search]', 'input[placeholder*="搜索"]', 'input[placeholder*="想吃"]', '#search-input', '.search-input input']) {
      const el = document.querySelector(sel);
      if (el && el.value && el.value.trim()) return el.value.trim();
    }
    return '';
  }

  /* ══════════════════════════════════════════════════════════
     1. 平台适配配置

     各平台页面结构随时会变，所以这里刻意写成「数据驱动」：
     认不出接口时靠通用启发式兜底，认错了改下面的配置即可。
     ══════════════════════════════════════════════════════════ */

  const PRICE_KEYS = [
    'price', 'currentPrice', 'salePrice', 'finalPrice', 'actualPrice', 'showPrice',
    'priceText', 'minPrice', 'startPrice', 'activityPrice', 'discountPrice',
    'originPrice', 'originalPrice', 'marketPrice', 'poiPrice', 'avgPrice',
  ];
  const NAME_KEYS = [
    'name', 'poiName', 'shopName', 'restaurantName', 'title', 'wmPoiName',
    'storeName', 'brandName', 'productName', 'spuName', 'itemName', 'shop_name',
  ];
  const URL_HINTS = [
    'search', 'poi', 'shop', 'restaurant', 'food', 'spu', 'product',
    'recommend', 'feed', 'list', 'homepage', 'delivery', 'shangou', 'waimai',
  ];

  const ADAPTERS = {
    meituan: {
      label: '美团',
      urlHints: ['search', 'poi', 'food', 'homepage', 'feed', 'waimai', 'restaurant'],
      // 美团搜索/首页返回里，商家通常在 poiList / poi_list / data.poiInfos 这类字段
      arrays: ['poiList', 'poi_list', 'poiInfos', 'poi_infos', 'searchResult', 'result', 'data', 'list', 'moduleList'],
      dom: {
        item: [
          '[class*="poi-card"]', '[class*="poiCard"]', '[class*="search-item"]',
          '[class*="shop-card"]', '[class*="restaurant"]', '[data-poi-id]', '[class*="poi-item"]',
        ],
        name: ['[class*="name"]', '[class*="title"]', 'h3', 'h4', '[class*="poi-name"]'],
        price: ['[class*="price"]', '[class*="Price"]'],
      },
    },
    eleme: {
      label: '饿了么 / 淘宝闪购',
      urlHints: ['search', 'shop', 'restaurant', 'spu', 'product', 'shangou', 'h5search', 'recommend'],
      arrays: ['shopList', 'shop_list', 'restaurantList', 'spus', 'spuList', 'itemList', 'data', 'result', 'list', 'items'],
      dom: {
        item: [
          '[class*="shop-card"]', '[class*="shopCard"]', '[class*="restaurant"]',
          '[class*="search-item"]', '[class*="spu"]', '[data-shop-id]', '[class*="card"]',
        ],
        name: ['[class*="name"]', '[class*="title"]', 'h3', 'h4'],
        price: ['[class*="price"]', '[class*="Price"]'],
      },
    },
    taobao: {
      label: '淘宝闪购',
      urlHints: ['search', 'shangou', 'spu', 'product', 'item', 'recommend', 'h5search', 'delivery'],
      arrays: ['shopList', 'spuList', 'itemList', 'list', 'items', 'data', 'result', 'auctions', 'mods'],
      dom: {
        item: [
          '[class*="shop-card"]', '[class*="spu-card"]', '[class*="item-card"]',
          '[class*="Card"]', '[class*="shopCard"]', '[data-spu-id]', '[class*="product"]',
        ],
        name: ['[class*="name"]', '[class*="title"]', 'h3', 'h4'],
        price: ['[class*="price"]', '[class*="Price"]'],
      },
    },
    jd: {
      label: '京东',
      urlHints: ['search', 'delivery', 'product', 'ware', 'shop', 'list', 'feed'],
      arrays: ['wareList', 'productList', 'skuList', 'shopList', 'data', 'result', 'list', 'items', 'feedList'],
      dom: {
        item: [
          '[class*="gl-item"]', '[class*="goods-item"]', '[class*="product-item"]',
          '[class*="sku"]', '[class*="card"]', '[data-sku]',
        ],
        name: ['[class*="p-name"]', '[class*="name"]', '[class*="title"]', 'h3', 'em'],
        price: ['[class*="p-price"]', '[class*="price"]', 'i', 'strong'],
      },
    },
  };

  const ADAPTER = ADAPTERS[PLATFORM] || {};

  /* ══════════════════════════════════════════════════════════
     2. 工具函数
     ══════════════════════════════════════════════════════════ */

  function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const s = String(v).replace(/[^\d.]/g, '');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }

  /** 从对象里按候选键取值，也支持 a.b.c 路径 */
  function pickKeys(obj, keys) {
    for (const k of keys) {
      if (k.includes('.')) {
        let cur = obj;
        for (const part of k.split('.')) { cur = cur?.[part]; if (cur === undefined) break; }
        if (cur !== undefined && cur !== null && cur !== '') return cur;
      } else if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
        return obj[k];
      }
    }
    return null;
  }

  /** 找价格：优先带"价"语义的键，避免误取 id / 销量 */
  function findPrice(obj) {
    for (const k of PRICE_KEYS) {
      const v = obj[k];
      const n = toNumber(v);
      if (n !== null && n > 0 && n < 100000) {
        // 有些平台价格以"分"为单位
        if (n > 1000 && /cent|fen/i.test(k)) return n / 100;
        return n;
      }
    }
    // 退一步：键名里含 price 的
    for (const [k, v] of Object.entries(obj)) {
      if (/price|amount|fee/i.test(k) && !/id|count|num|rate|ratio|level/i.test(k)) {
        const n = toNumber(v);
        if (n !== null && n > 0 && n < 100000) return n;
      }
    }
    return null;
  }

  function findName(obj) {
    const v = pickKeys(obj, NAME_KEYS);
    if (v && typeof v === 'string' && v.trim().length >= 2 && v.length <= 60) return v.trim();
    return null;
  }

  /** 通用：递归找出「看起来像候选套餐列表」的数组 */
  function harvest(node, out, depth = 0) {
    if (!node || depth > 6 || out.length >= 80) return;
    if (Array.isArray(node)) {
      const objs = node.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length >= 2) {
        for (const o of objs) {
          if (out.length >= 80) break;
          const price = findPrice(o);
          const name = findName(o);
          if (price !== null && name) {
            out.push({ name, price, raw: o });
          }
        }
      }
      for (const item of node.slice(0, 40)) harvest(item, out, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      // 先看适配器点名的字段
      for (const key of (ADAPTER.arrays || [])) {
        if (node[key]) harvest(node[key], out, depth + 1);
        if (out.length >= 80) return;
      }
      for (const [k, v] of Object.entries(node)) {
        if (out.length >= 80) return;
        if (typeof v === 'object' && v !== null) harvest(v, out, depth + 1);
      }
    }
  }

  /** 原始记录 → 标准候选 */
  function normalizeRecord(rec, keyword) {
    const o = rec.raw || {};
    const price = rec.price;
    const shopName = findName(o) || rec.name;
    // 套餐名 / 菜名
    const dishName = pickKeys(o, ['spuName', 'productName', 'itemName', 'dishName', 'foodName', 'title', 'name']);
    const deliveryFee = toNumber(pickKeys(o, ['shippingFee', 'deliveryFee', 'freight', 'delivery_fee', 'shipping_fee']));
    const packingFee = toNumber(pickKeys(o, ['packingFee', 'boxFee', 'packageFee', 'packing_fee']));
    const originPrice = toNumber(pickKeys(o, ['originPrice', 'originalPrice', 'marketPrice', 'origin_price']));
    const rating = toNumber(pickKeys(o, ['rating', 'score', 'wmPoiScore', 'shopScore', 'avgScore', 'commentScore']));
    const reviewCount = toNumber(pickKeys(o, ['reviewCount', 'commentCount', 'comments', 'comment_num', 'review_num']));
    const monthlySales = toNumber(pickKeys(o, ['monthlySales', 'soldCount', 'monthSales', 'saleCount', 'sold_num']));
    const eta = toNumber(pickKeys(o, ['deliveryTime', 'eta', 'avgDeliveryTime', 'delivery_time', 'timeTip']));
    const minSpend = toNumber(pickKeys(o, ['minPrice', 'minOrderPrice', 'startPrice', 'min_order_price']));
    const image = pickKeys(o, ['image', 'picture', 'picUrl', 'logo', 'imgUrl', 'imageUrl']);

    // 折扣/满减文案
    const deals = [];
    const activityText = pickKeys(o, ['activityText', 'discountText', 'promotionText', 'couponText', 'activity']);
    if (typeof activityText === 'string' && activityText.trim()) {
      for (const piece of activityText.split(/[;；|,，]/).slice(0, 4)) {
        const t = piece.trim();
        if (!t) continue;
        const kind = /减|券|红包/.test(t) ? 'coupon' : /折/.test(t) ? 'discount' : /免|配送/.test(t) ? 'freeship' : 'discount';
        deals.push({ kind, label: t.slice(0, 20), amount: 0 });
      }
    }
    const discounts = o.discounts || o.coupons || o.activities;
    if (Array.isArray(discounts)) {
      for (const d of discounts.slice(0, 4)) {
        if (!d) continue;
        const label = String(typeof d === 'string' ? d : (d.text || d.name || d.label || d.title || '')).trim();
        if (!label) continue;
        const amount = toNumber(d.amount || d.reduce || d.value) || 0;
        const kind = /减|券/.test(label) ? 'coupon' : /折/.test(label) ? 'discount' : /免/.test(label) ? 'freeship' : 'discount';
        deals.push({ kind, label: label.slice(0, 20), amount });
      }
    }

    const dealSum = deals.reduce((s, d) => s + (d.amount || 0), 0);
    const shipping = deliveryFee || 0;
    const packing = packingFee || 0;
    const finalPrice = Math.round(Math.max(0.01, price - dealSum + shipping + packing) * 100) / 100;

    return {
      merchant: String(shopName).slice(0, 40),
      rating: rating || null,
      reviewCount: reviewCount || 0,
      good: [],
      bad: [],
      packages: [{
        id: `${PLATFORM}-${hash(String(shopName) + String(dishName) + price)}`,
        name: String(dishName || shopName).slice(0, 60),
        dish: String(dishName || shopName).slice(0, 60),
        art: guessArt(String(dishName || '') + ' ' + String(shopName || '')),
        cuisine: '',
        basePrice: originPrice && originPrice >= price ? originPrice : price,
        shippingFee: shipping,
        packingFee: packing,
        deals,
        minSpend: minSpend || 0,
        couponUsable: true,
        finalPrice,
        etaMin: eta || null,
        rating: rating || null,
        reviewCount: reviewCount || 0,
        monthlySales: monthlySales || 0,
        image: typeof image === 'string' ? image : null,
        keyword,
        // 保留可追溯性：这条价格是从哪个接口、什么时间拿到的
        provenance: { api: rec.api || '', at: Date.now() },
      }],
    };
  }

  function hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return (h >>> 0).toString(36);
  }

  const ART_WORDS = {
    'noodles': ['面', '粉', '米线', '拉面', '意面', '拌面'],
    'rice': ['饭', '盖饭', '炒饭', '煲仔', '便当'],
    'burger': ['汉堡', '炸鸡', '薯条', '鸡块', '三明治'],
    'pizza': ['披萨', '比萨', 'pizza', '焗'],
    'hotpot': ['火锅', '麻辣烫', '冒菜', '串串', '香锅'],
    'bbq': ['烧烤', '烤串', '烤肉', '烤鱼', '铁板'],
    'dumpling': ['饺子', '水饺', '包子', '小笼', '馄饨', '锅贴'],
    'sushi': ['寿司', '刺身', '日料', '鳗鱼', '定食'],
    'salad': ['沙拉', '轻食', '减脂', '低卡', '鸡胸'],
    'dessert': ['甜品', '奶茶', '蛋糕', '冰淇淋', '布丁'],
    'congee': ['粥', '汤', '羹', '煲', '砂锅'],
    'crayfish': ['小龙虾', '海鲜', '虾', '蟹', '花甲'],
  };
  function guessArt(text) {
    for (const [art, words] of Object.entries(ART_WORDS)) {
      if (words.some((w) => text.includes(w))) return art;
    }
    return 'default';
  }

  /* ══════════════════════════════════════════════════════════
     3. DOM 兜底：接口认不出来时，直接读渲染结果
     ══════════════════════════════════════════════════════════ */

  function parseFromDom(keyword) {
    const cfg = ADAPTER.dom || {};
    const items = [];
    const seen = new Set();

    for (const sel of (cfg.item || [])) {
      for (const node of document.querySelectorAll(sel)) {
        if (items.length >= 40) break;
        const text = (node.innerText || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 4 || text.length > 400) continue;
        if (seen.has(text)) continue;

        // 价格：先看专用选择器，再全局正则
        let price = null;
        for (const psel of (cfg.price || [])) {
          const pel = node.querySelector(psel);
          if (pel) { price = toNumber(pel.textContent); if (price) break; }
        }
        if (price === null) {
          const m = text.match(/(?:¥|￥)\s*(\d+(?:\.\d+)?)/) || text.match(/(\d+(?:\.\d+)?)\s*元/);
          if (m) price = toNumber(m[1]);
        }
        if (!price || price <= 0 || price > 2000) continue;

        // 名称：先看专用选择器，再取最长的一行短文本
        let name = null;
        for (const nsel of (cfg.name || [])) {
          const nel = node.querySelector(nsel);
          const t = nel && (nel.textContent || '').replace(/\s+/g, ' ').trim();
          if (t && t.length >= 2 && t.length <= 40) { name = t; break; }
        }
        if (!name) {
          const lines = text.split(/[\n·|]/).map((s) => s.trim())
            .filter((s) => s.length >= 2 && s.length <= 30 && !/^[¥￥\d\s.]+$/.test(s) && !/配送|起送|分钟|评价|月售/.test(s));
          name = lines[0] || null;
        }
        if (!name) continue;

        // 配送费 / 起送价 / 时长
        const feeM = text.match(/(?:配送费|配送)\s*[¥￥]?\s*(\d+(?:\.\d+)?)/);
        const etaM = text.match(/(\d+)\s*分钟/);
        const ratingM = text.match(/([45]\.\d)/);
        const salesM = text.match(/月售\s*(\d+)/);

        seen.add(text);
        items.push({
          merchant: name.slice(0, 40),
          rating: ratingM ? toNumber(ratingM[1]) : null,
          reviewCount: 0,
          good: [],
          bad: [],
          packages: [{
            id: `${PLATFORM}-dom-${hash(name + price)}`,
            name,
            dish: name,
            art: guessArt(name),
            cuisine: '',
            basePrice: price,
            shippingFee: feeM ? toNumber(feeM[1]) : 0,
            packingFee: 0,
            deals: [],
            minSpend: 0,
            couponUsable: true,
            finalPrice: price + (feeM ? toNumber(feeM[1]) : 0),
            etaMin: etaM ? toNumber(etaM[1]) : null,
            rating: ratingM ? toNumber(ratingM[1]) : null,
            reviewCount: 0,
            monthlySales: salesM ? toNumber(salesM[1]) : 0,
            image: null,
            keyword,
            provenance: { api: 'dom', at: Date.now() },
          }],
        });
      }
    }
    return items;
  }

  /* ══════════════════════════════════════════════════════════
     4. 嗅探：拦截页面自己发出的请求

     两种情况：
       a) 本脚本跑在主世界（中继通过 CDP 注入）→ 直接包 fetch/XHR
       b) 本脚本跑在隔离世界（油猴）→ 包不到页面的真 fetch，
          把代码序列化后插进 <script> 走主世界，结果用 postMessage 送回
     ══════════════════════════════════════════════════════════ */

  const SNIFF_TAG = '__mealpicker_sniff__';

  /** 真正干活的钩子代码；两种世界都要用，所以写成字符串 */
  function snifferSource() {
    return `(${function () {
      const TAG = '__mealpicker_sniff__';
      const MAX = 900 * 1024;          // 超过这个大小的响应直接放弃
      const post = (payload) => {
        try { window.postMessage({ [TAG]: true, ...payload }, '*'); } catch (e) { /* ignore */ }
      };
      const HINT = /search|poi|shop|restaurant|food|spu|product|recommend|feed|list|homepage|delivery|waimai|shangou|item|card/i;

      // ── fetch ──
      const origFetch = window.fetch;
      if (typeof origFetch === 'function') {
        window.fetch = function (...args) {
          const p = origFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
            p.then((res) => {
              try {
                if (!res || !res.ok) return;
                const ct = res.headers.get('content-type') || '';
                if (!/json|text/i.test(ct)) return;
                if (!HINT.test(url)) return;
                const len = Number(res.headers.get('content-length') || 0);
                if (len > MAX) return;
                res.clone().text().then((text) => {
                  if (text && text.length < MAX) post({ kind: 'fetch', url, text });
                }).catch(() => {});
              } catch (e) { /* ignore */ }
            }).catch(() => {});
          } catch (e) { /* ignore */ }
          return p;
        };
      }

      // ── XMLHttpRequest ──
      const OrigOpen = XMLHttpRequest.prototype.open;
      const OrigSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        try { this.__mp_url = String(url || ''); } catch (e) { /* ignore */ }
        return OrigOpen.call(this, method, url, ...rest);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        try {
          const url = this.__mp_url || '';
          if (HINT.test(url)) {
            this.addEventListener('load', () => {
              try {
                const ct = this.getResponseHeader && this.getResponseHeader('content-type') || '';
                const type = this.responseType;
                if (type && type !== 'text' && type !== 'json') return;
                let text = null;
                if (type === 'json') text = JSON.stringify(this.response);
                else if (typeof this.responseText === 'string') text = this.responseText;
                if (!text || text.length > MAX) return;
                post({ kind: 'xhr', url, text });
              } catch (e) { /* ignore */ }
            });
          }
        } catch (e) { /* ignore */ }
        return OrigSend.apply(this, args);
      };
    }.toString()})()`;
  }

  /**
   * 安装嗅探钩子。
   * 先试 <script> 注入（隔离世界必须走这条），失败或已经在主世界时直接执行。
   */
  function installSniffer() {
    if (window.__mealpickerSnifferOn) return true;

    const src = snifferSource();

    // a) 已经在主世界：直接跑，不需要 postMessage 中转
    if (window.__mealpickerMainWorld === true) {
      try {
        (0, eval)(src);
        window.__mealpickerSnifferOn = true;
        return true;
      } catch (e) {
        LOG('主世界直接挂钩失败：', e.message);
      }
    }

    // b) 隔离世界：插 <script> 到页面里
    try {
      const s = document.createElement('script');
      s.textContent = src;
      (document.head || document.documentElement).appendChild(s);
      s.remove();
      window.__mealpickerSnifferOn = true;
      return true;
    } catch (e) {
      LOG('主世界注入失败（可能是 CSP），将只使用 DOM 兜底：', e.message);
      return false;
    }
  }

  /** 已处理的响应，避免同一份数据重复解析 */
  const handled = new Set();
  /** 收集到的候选 */
  let collected = [];
  let collectedSources = new Set();
  let lastHarvestAt = 0;

  function ingestSniffed(d) {
    if (!d || typeof d.text !== 'string' || !d.text) return;

    const key = (d.url || '') + '#' + d.text.length;
    if (handled.has(key)) return;
    handled.add(key);
    if (handled.size > 400) handled.clear();

    let json;
    try { json = JSON.parse(d.text); } catch { return; }

    const found = [];
    try { harvest(json, found); } catch (e) { /* ignore */ }

    if (found.length) {
      const kw = currentKeyword();
      const offers = found.slice(0, 30).map((r) => normalizeRecord({ ...r, api: String(d.url || '').slice(0, 160) }, kw));
      collected.push(...offers);
      collectedSources.add(String(d.url || '').slice(0, 160));
      lastHarvestAt = Date.now();
      LOG(`从接口拿到 ${offers.length} 条候选`, String(d.url || '').slice(0, 100));
    } else {
      LOG('接口响应里没识别出候选', String(d.url || '').slice(0, 100), '（可把这条响应存下来调适配）');
    }
  }

  // 主世界注入的结果靠 postMessage 回来；主世界直挂时也走同一条路，
  // 这样只有一份解析逻辑。
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d[SNIFF_TAG] !== true) return;
    ingestSniffed(d);
  });

  /* ══════════════════════════════════════════════════════════
     5. 与中继通信
     ══════════════════════════════════════════════════════════ */

  const HAS_GM = typeof GM_xmlhttpRequest === 'function'
    || (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function');

  /* ── 回传通道 ──────────────────────────────────────────────
     平台页都是 https，中继是 http://127.0.0.1。实测在真实平台页上，
     页面里的 fetch 会被 Chrome 的 Private Network Access 直接拒掉：

       Access to fetch at 'http://127.0.0.1:PORT/api/health' from origin
       'https://waimai.meituan.com' has been blocked by CORS policy:
       Permission was denied for this request to access the `loopback` address

     所以托管浏览器（中继自己拉起来的那只）改用 CDP binding：中继通过
     调试协议往页面里注入一个 __mealPickerRelay() 函数，调用它数据会走
     DevTools 通道回到中继，根本不经过网络栈 —— CORS / PNA / 混合内容 /
     页面 CSP 全都管不着它。

     油猴脚本那条路走 GM_xmlhttpRequest，它是扩展的特权请求，同样不受限。
     普通 fetch 只在页面本身就是本地 http 时才用得上（比如自检）。
     ────────────────────────────────────────────────────────── */
  const BINDING = typeof window.__mealPickerRelay === 'function' ? window.__mealPickerRelay : null;
  const HAS_BINDING = !!BINDING;
  /** 托管模式：任务由中继在注入时就写好，不用再去拉 */
  const BAKED_TASK = (window.__mealPickerTask && typeof window.__mealPickerTask === 'object')
    ? window.__mealPickerTask : null;

  function request(opts) {
    return new Promise((resolve, reject) => {
      if (HAS_GM) {
        const gm = (typeof GM_xmlhttpRequest === 'function')
          ? GM_xmlhttpRequest
          : GM.xmlHttpRequest.bind(GM);
        gm({
          method: opts.method || 'GET',
          url: opts.url,
          headers: opts.headers || { 'Content-Type': 'application/json' },
          data: opts.body,
          timeout: opts.timeout || 8000,
          onload: (r) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
          onerror: () => reject(new Error('中继不可达')),
          ontimeout: () => reject(new Error('中继超时')),
        });
        return;
      }
      // 没有 GM 权限时用普通 fetch：中继对所有来源都回了 CORS 头，
      // 并且处理了 OPTIONS 预检，所以跨源也能通。
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeout || 8000) : null;
      fetch(opts.url, {
        method: opts.method || 'GET',
        headers: opts.headers || { 'Content-Type': 'application/json' },
        body: opts.body,
        mode: 'cors',
        signal: ctl ? ctl.signal : undefined,
      }).then(async (r) => {
        if (timer) clearTimeout(timer);
        resolve({ ok: r.ok, status: r.status, text: await r.text() });
      }).catch((e) => {
        if (timer) clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** 走 CDP 通道回传；成功返回 true */
  function sendViaBinding(payload) {
    if (!HAS_BINDING) return false;
    try {
      BINDING(JSON.stringify(payload));
      return true;
    } catch { return false; }
  }

  async function relayAlive() {
    // binding 是中继挂上来的，它在就说明中继活着
    if (HAS_BINDING) return true;
    try {
      const r = await request({ url: `${RELAY}/api/health`, timeout: 3000 });
      return r.ok;
    } catch { return false; }
  }

  async function fetchTask() {
    // 托管模式：任务在注入时就写好了，直接拿
    if (BAKED_TASK && !taskConsumed) return BAKED_TASK;
    if (HAS_BINDING) return null; // 托管模式但这一轮没有任务，别去 fetch 撞 PNA
    try {
      const r = await request({ url: `${RELAY}/api/task?platform=${PLATFORM}`, timeout: 4000 });
      if (!r.ok) return null;
      const j = JSON.parse(r.text);
      return j.task || null;
    } catch { return null; }
  }

  async function submit(offers, extra = {}) {
    const payload = {
      platform: PLATFORM,
      keyword: currentKeyword(),
      page: location.href,
      offers,
      version: VERSION,
      ...extra,
    };
    if (sendViaBinding(payload)) return true;
    try {
      const r = await request({
        method: 'POST',
        url: `${RELAY}/api/prices`,
        body: JSON.stringify(payload),
        timeout: 10000,
      });
      return r.ok;
    } catch { return false; }
  }

  async function sayHello() {
    const payload = {
      version: VERSION,
      ua: navigator.userAgent,
      platforms: [PLATFORM],
      page: location.href,
    };
    if (sendViaBinding({ kind: 'hello', ...payload })) return;
    try {
      await request({
        method: 'POST',
        url: `${RELAY}/api/hello`,
        body: JSON.stringify(payload),
        timeout: 4000,
      });
    } catch { /* 中继没开就算了 */ }
  }

  /* ══════════════════════════════════════════════════════════
     6. 采集编排
     ══════════════════════════════════════════════════════════ */

  function dedupe(offers) {
    const map = new Map();
    for (const o of offers) {
      const pk = o.packages?.[0];
      if (!pk) continue;
      const key = `${o.merchant}|${pk.dish}`;
      const prev = map.get(key);
      if (!prev || (pk.finalPrice && pk.finalPrice < prev.packages[0].finalPrice)) map.set(key, o);
    }
    return Array.from(map.values());
  }

  /** 采一轮：等页面把接口请求发出来，再合并 DOM 结果 */
  async function collectOnce({ waitMs = 9000, minOffers = 5 } = {}) {
    collected = [];
    collectedSources = new Set();
    const start = Date.now();
    let domTried = false;

    while (Date.now() - start < waitMs) {
      await new Promise((r) => setTimeout(r, 700));
      const uniq = dedupe(collected);
      if (uniq.length >= minOffers && Date.now() - lastHarvestAt > 1200) return uniq;
      // 中途试一次 DOM，页面可能已经渲染但接口没被拦到
      if (!domTried && Date.now() - start > 3500) {
        domTried = true;
        try {
          const dom = parseFromDom(currentKeyword());
          if (dom.length) {
            collected.push(...dom);
            collectedSources.add('dom');
            LOG(`DOM 兜底读到 ${dom.length} 条`);
          }
        } catch (e) { LOG('DOM 兜底失败', e.message); }
      }
    }
    // 最后再兜一次 DOM
    if (!collected.length) {
      try {
        const dom = parseFromDom(currentKeyword());
        if (dom.length) { collected.push(...dom); collectedSources.add('dom'); }
      } catch { /* ignore */ }
    }
    return dedupe(collected);
  }

  let running = false;
  /** 注入时就带下来的任务只认一次，免得反复采 */
  let taskConsumed = false;

  async function runForTask(task) {
    if (running) return;
    running = true;
    if (BAKED_TASK && task === BAKED_TASK) taskConsumed = true;
    try {
      const keyword = task.keyword || currentKeyword();
      LOG(`开始采集「${keyword}」`);
      // 如果页面上的关键词和任务不一致，先纠正 URL（保留登录态，只是换搜索词）
      const cur = currentKeyword();
      if (keyword && cur && cur !== keyword) {
        const u = new URL(location.href);
        for (const k of ['keyword', 'q', 'kw', 'query', 'wq']) {
          if (u.searchParams.has(k)) u.searchParams.set(k, keyword);
        }
        if (u.toString() !== location.href) {
          LOG('关键词不一致，跳转到任务关键词');
          location.replace(u.toString());
          return;   // 新页面加载后会自动重新领任务
        }
      }

      const offers = await collectOnce({ waitMs: Math.min(task.timeoutMs || 20000, 20000) });
      const ok = await submit(offers, {
        warnings: offers.length ? [] : ['没有从这个页面读到可用的价格数据'],
      });
      LOG(ok ? `已回传 ${offers.length} 条` : '回传失败');
    } finally {
      running = false;
    }
  }

  /* 轮询领任务：工具页面打开本标签页后，这里会自己接活 */
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    // 托管模式没有带任务下来，就说明这一轮不需要采，别空转
    if (HAS_BINDING && !BAKED_TASK) return;
    let tries = 0;
    pollTimer = setInterval(async () => {
      tries++;
      if (tries > 120) { clearInterval(pollTimer); pollTimer = null; return; }
      const t = await fetchTask();
      if (t) {
        clearInterval(pollTimer);
        pollTimer = null;
        await runForTask(t);
      }
    }, 1500);
  }

  /* ══════════════════════════════════════════════════════════
     7. 启动
     ══════════════════════════════════════════════════════════ */

  installSniffer();

  async function boot() {
    const alive = await relayAlive();
    if (!alive) {
      LOG(`本地中继没在跑（${RELAY}）。先启动它：node relay/server.mjs`);
      return;
    }
    await sayHello();
    LOG(`已连接中继 ${RELAY}，平台=${PLATFORM}`);
    startPolling();

    // 页面渲染完再补一次：有些平台的接口在首次渲染后才发
    window.addEventListener('load', () => {
      setTimeout(() => startPolling(), 800);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // 暴露一个手动入口，方便调试
  try {
    Object.defineProperty(window, '__mealPickerCollector', {
      value: {
        platform: PLATFORM,
        relay: RELAY,
        version: VERSION,
        mainWorld: window.__mealpickerMainWorld === true,
        collect: () => collectOnce({ waitMs: 8000 }),
        submit: (offers) => submit(offers),
        task: fetchTask,
        dom: () => parseFromDom(currentKeyword()),
      },
      configurable: true,
    });
  } catch { /* ignore */ }
}
