/**
 * 冒烟测试：在 Node 里跑通核心链路（不依赖浏览器）
 *
 *   node scripts/test.mjs
 *
 * 覆盖：内置语义转写 → 采集结果规范化 → 加权排名 → 推荐理由
 *      本地中继 API → 凭据保险箱加密/解密/口令模式 → 设置读写
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/* ── 最小浏览器环境桩 ── */
const storage = new Map();
globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
  get length() { return storage.size; },
  key: (i) => Array.from(storage.keys())[i] ?? null,
};
// Node 18+ 自带 WebCrypto，无需注入
if (!globalThis.crypto?.subtle) throw new Error('需要 Node 18+ 的 WebCrypto 支持');

const { extractBuiltin, mergePrefs } = await import('../web/js/taste.js');
const { normalizeOffer, normalizeBatch, resolveSource, enabledPlatforms } = await import('../web/js/adapters.js');
const { relayBase, searchUrlFor } = await import('../web/js/realtime.js');
const { scoreCandidates, buildReasons, buildQuotes, summarize } = await import('../web/js/engine.js');
const { estimateCost } = await import('../web/js/llm.js');
const { DEFAULT_SETTINGS, PLATFORMS } = await import('../web/js/catalog.js');
const { Store } = await import('../web/js/store.js');
const { Vault, CRYPTO_MODE } = await import('../web/js/crypto.js');

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};
const ta = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
};

/* ══════════ 1. 内置语义转写 ══════════ */
console.log('\n[1] 内置语义转写');

t('辣的 + 预算 + 一人', () => {
  const r = extractBuiltin('想吃点辣的但是别太贵，一个人吃，30以内');
  assert.ok(r.keywords.length >= 1, 'kw 为空');
  assert.ok(r.tastes.includes('spicy'), '没识别出辣');
  assert.ok(r.tastes.includes('value'), '没识别出"别太贵"');
  assert.equal(r.budget, 30, `预算应为 30，实际 ${r.budget}`);
  assert.equal(r.party, 1, `人数应为 1，实际 ${r.party}`);
  // 这句话里没有具体菜品名词，不应该硬猜品类（"一个人吃"里的"人"是噪音）
  assert.equal(r.kinds.length, 0, `不该猜出品类的具体名字，实际 ${JSON.stringify(r.kinds)}`);
  assert.ok(r.keywords[0].length >= 2, '关键词不该是单字');
});

t('有明确菜名时能认出品类', () => {
  for (const [q, kind] of [['来碗牛肉面', 'noodles'], ['想吃寿司', 'sushi'], ['来个汉堡', 'burger']]) {
    const r = extractBuiltin(q);
    assert.ok(r.kinds.includes(kind), `「${q}」→ ${JSON.stringify(r.kinds)}，期望含 ${kind}`);
  }
});

t('粥 + 忌口葱', () => {
  const r = extractBuiltin('感冒了想喝点热乎的粥，不要葱');
  assert.ok(r.kinds.includes('congee'), `品类应含 congee，实际 ${JSON.stringify(r.kinds)}`);
  assert.ok(r.avoid.includes('葱'), '没识别出忌口');
});

t('不要辣优先于想吃辣', () => {
  const r = extractBuiltin('想吃辣的但是不要辣');
  assert.ok(!r.tastes.includes('spicy'), '忌口与偏好冲突时辣应被移除');
});

t('中文数字预算', () => {
  const r = extractBuiltin('预算三十块左右，随便来点');
  assert.equal(r.budget, 30);
});

t('兜底不崩', () => {
  const r = extractBuiltin('嗯');
  assert.ok(r.keywords.length >= 1);
  assert.ok(r.keywords[0].length > 0);
});

t('关键词永远是"能搜的词"，不是整句原话', () => {
  const cases = [
    '想吃点辣的但是别太贵，一个人吃，40以内',
    '想吃点清淡的，最近在控制体重',
    '嗯',
    '不知道吃啥',
    '今天随便来点吧',
  ];
  for (const q of cases) {
    const r = extractBuiltin(q);
    assert.ok(r.keywords.length >= 1, `「${q}」没有产出关键词`);
    for (const k of r.keywords) {
      assert.ok(k.length >= 2 && k.length <= 12, `「${q}」产出了异常关键词「${k}」`);
      assert.ok(!q.includes(k) || k.length <= q.length, '关键词不应是整句');
      assert.ok(!/[，,。！!？?]/.test(k), `关键词里不该有标点：「${k}」`);
    }
    // 不能把整句直接当关键词
    assert.ok(!r.keywords.includes(q), `「${q}」把整句当成了关键词`);
  }
});

t('说不出菜名但说了口味时，能推出可搜的具体词', () => {
  const spicy = extractBuiltin('想吃点辣的但是别太贵，一个人吃，40以内');
  assert.ok(spicy.keywords.some((k) => /麻辣|辣/.test(k)), `辣味兜底词不对：${JSON.stringify(spicy.keywords)}`);
  const light = extractBuiltin('最近在控制体重，想吃点清淡的');
  assert.ok(light.keywords.length >= 2, '清淡兜底词不足');
});

t('设置里的口味会合并进来', () => {
  const r = mergePrefs(extractBuiltin('来碗面'), { tastes: ['light'], budget: { enabled: true, max: 25 } });
  assert.ok(r.tastes.includes('light'));
  assert.equal(r.budget, 25);
});

/* ══════════ 2. 采集结果规范化 ══════════ */
console.log('\n[2] 采集结果 → 候选');

const settings = structuredClone(DEFAULT_SETTINGS);
settings.platforms.meituan.enabled = true;
settings.platforms.eleme.enabled = true;
settings.platforms.jd.enabled = true;
settings.platforms.taobao.enabled = true;

const parsed = extractBuiltin('想吃点辣的但是别太贵，一个人吃，40以内');

/** 模拟采集器从平台接口读到的原始记录（结构与 collector 里的 normalizeRecord 输出一致） */
const COLLECTED = {
  meituan: [
    {
      merchant: '蜀香源川菜馆', rating: 4.7, reviewCount: 2381,
      good: [
        { text: '分量是真的足，一个人吃撑了', tag: '份量足' },
        { text: '出餐快，到手还是烫的', tag: '出餐快' },
      ],
      bad: [{ text: '微微有点咸，但整体很香', tag: '偏咸' }],
      packages: [{
        id: 'mt-1', name: '水煮肉片套餐', dish: '水煮肉片套餐', art: 'hotpot',
        basePrice: 42, shippingFee: 4, packingFee: 1,
        deals: [{ kind: 'coupon', label: '满 40 减 12', amount: 12, threshold: 40 }],
        finalPrice: 35, etaMin: 32, rating: 4.7, reviewCount: 2381, monthlySales: 890,
        provenance: { api: 'https://wx.waimai.meituan.com/weapp/v1/poi/food', at: Date.now() },
      }],
    },
    {
      merchant: '老碗面', rating: 4.4, reviewCount: 902,
      good: [{ text: '味道稳定，回购第 N 次了', tag: '稳定' }],
      bad: [],
      packages: [{
        id: 'mt-2', name: '油泼面', dish: '油泼面', art: 'noodles',
        basePrice: 26, shippingFee: 3, packingFee: 1,
        deals: [], finalPrice: 30, etaMin: 25, rating: 4.4, reviewCount: 902, monthlySales: 420,
      }],
    },
  ],
  eleme: [
    {
      merchant: '麻辣诱惑', rating: 4.6, reviewCount: 1502,
      good: [
        { text: '辣度刚好，够味但不烧胃', tag: '辣度合适' },
        { text: '性价比在这个价位里很难找到对手', tag: '性价比高' },
      ],
      bad: [{ text: '份量比图片少一些', tag: '图文有差' }],
      packages: [{
        id: 'el-1', name: '麻辣香锅双人份', dish: '麻辣香锅双人份', art: 'hotpot',
        basePrice: 58, shippingFee: 0, packingFee: 2,
        deals: [{ kind: 'discount', label: '7.5 折', amount: 14.5 }],
        finalPrice: 45.5, etaMin: 38, rating: 4.6, reviewCount: 1502, monthlySales: 610,
      }],
    },
  ],
};

t('规范化：字段齐全、价格自洽', () => {
  const offers = normalizeBatch(COLLECTED.meituan, 'meituan');
  assert.equal(offers.length, 2, `应有 2 家店，实际 ${offers.length}`);
  for (const o of offers) {
    assert.ok(o.merchant.length >= 2, '店名为空');
    assert.equal(o.platform, 'meituan');
    assert.equal(o.source, 'realtime');
    for (const p of o.packages) {
      assert.ok(p.finalPrice > 0, '价格非正');
      const dealSum = p.deals.reduce((s, d) => s + d.amount, 0);
      const expect = Math.round((p.basePrice - dealSum + p.shippingFee + p.packingFee) * 100) / 100;
      assert.ok(Math.abs(expect - p.finalPrice) < 0.02, `价格不符：${expect} vs ${p.finalPrice}`);
      assert.ok(p.art && p.art.length > 0, '缺插画 id');
    }
  }
});

t('规范化：脏数据被挡掉，不会污染候选', () => {
  const junk = [
    { merchant: '', packages: [{ dish: 'x', finalPrice: 10 }] },          // 无店名
    { merchant: '有店名', packages: [] },                                  // 无套餐
    { merchant: '价格为零', packages: [{ dish: 'y', finalPrice: 0 }] },    // 价格非正
    null,
    'not an object',
  ];
  const out = normalizeBatch(junk, 'jd');
  assert.equal(out.length, 0, `应全部过滤，实际留下 ${out.length}`);
});

t('规范化：缺字段时用安全默认值，不抛错', () => {
  const o = normalizeOffer({ merchant: '仅店名', packages: [{ dish: '盖饭', basePrice: 20 }] }, 'taobao');
  const p = o.packages[0];
  assert.equal(p.finalPrice, 20);
  assert.equal(p.shippingFee, 0);
  assert.deepEqual(p.deals, []);
  assert.equal(o.rating, 0);
});

t('数据源解析：默认走实时采集', () => {
  assert.equal(resolveSource({ mode: 'realtime' }, 'meituan'), 'realtime');
  assert.equal(resolveSource({ mode: 'auto', endpoint: '' }, 'meituan'), 'realtime');
  assert.equal(resolveSource({ mode: 'auto', endpoint: 'https://x/y' }, 'meituan'), 'custom');
  assert.equal(resolveSource({ mode: 'custom', endpoint: '' }, 'meituan'), 'none');
  assert.equal(resolveSource({ mode: 'custom', endpoint: 'https://x/y' }, 'meituan'), 'custom');
  assert.equal(resolveSource({ mode: 'none' }, 'meituan'), 'none');
  assert.equal(resolveSource(undefined, 'meituan'), 'realtime', '缺配置时也应有默认');
});

t('平台清单与搜索地址', () => {
  assert.equal(enabledPlatforms(settings).length, 4);
  for (const p of PLATFORMS) {
    const url = searchUrlFor(p.id, '麻辣香锅');
    assert.ok(url.startsWith('https://'), `${p.id} 搜索地址不合法：${url}`);
    assert.ok(url.includes(encodeURIComponent('麻辣香锅')), `${p.id} 没有带上关键词`);
  }
});

t('中继地址可用设置里的端口', () => {
  assert.equal(relayBase({ dataSource: { relayPort: 9000 } }), 'http://127.0.0.1:9000');
  assert.equal(relayBase({}), 'http://127.0.0.1:8765');
  assert.equal(relayBase(undefined), 'http://127.0.0.1:8765');
});

/* ══════════ 2b. 本地中继服务 ══════════ */
console.log('\n[2b] 本地中继');

const RELAY_PORT = 18700 + Math.floor(Math.random() * 200);
const relay = spawn(process.execPath, [join(root, 'relay', 'server.mjs'), '--port', String(RELAY_PORT), '--quiet', '--no-open'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let relayErr = '';
relay.stderr.on('data', (d) => { relayErr += String(d); });

const R = (p) => `http://127.0.0.1:${RELAY_PORT}${p}`;

async function waitRelay(t = 8000) {
  const end = Date.now() + t;
  while (Date.now() < end) {
    try { const r = await fetch(R('/api/health')); if (r.ok) return true; } catch { /* 等 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('中继没起来：' + relayErr);
}

let relayUp = false;
try { relayUp = await waitRelay(); } catch (e) { console.log('  ✗ ' + e.message); fail++; }

if (relayUp) {
  await ta('健康检查返回自身信息', async () => {
    const j = await (await fetch(R('/api/health'))).json();
    assert.equal(j.ok, true);
    assert.equal(j.app, 'meal-picker-relay');
    assert.equal(j.collectorSeen, null, '还没采集器时应为 null');
  });

  await ta('托管工具页面与采集器脚本', async () => {
    const html = await (await fetch(R('/'))).text();
    assert.ok(html.includes('ask-input'), '首页没有输入框');
    const js = await (await fetch(R('/collector.user.js'))).text();
    assert.ok(js.includes('==UserScript=='), '采集器脚本头缺失');
    assert.ok(!js.includes('__RELAY_PORT__'), '端口占位符没被替换');
    const m = js.match(/const RELAY_PORT = (\d+);/);
    assert.ok(m, '采集器里没有 RELAY_PORT');
    assert.equal(Number(m[1]), RELAY_PORT, `采集器里的端口不对：${m[1]}`);
    const install = await (await fetch(R('/install'))).text();
    assert.ok(install.includes('Tampermonkey'), '安装页内容不对');
  });

  await ta('采集任务：登记 → 回传 → 取价', async () => {
    const reg = await (await fetch(R('/api/collect'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '麻辣香锅', platforms: ['meituan', 'eleme'] }),
    })).json();
    assert.equal(reg.ok, true);
    assert.deepEqual(reg.task.platforms, ['meituan', 'eleme']);
    assert.equal(reg.task.done, false);

    // 采集器领活
    const tk = await (await fetch(R('/api/task?platform=meituan'))).json();
    assert.ok(tk.task, '采集器应该能领到任务');
    const none = await (await fetch(R('/api/task?platform=jd'))).json();
    assert.equal(none.task, null, '不在任务内的平台不该领到活');

    // 回传
    const post = await (await fetch(R('/api/prices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'meituan', keyword: '麻辣香锅', offers: COLLECTED.meituan }),
    })).json();
    assert.equal(post.ok, true);
    assert.deepEqual(post.progress.received, ['meituan']);
    assert.deepEqual(post.progress.missing, ['eleme']);
    assert.equal(post.progress.done, false);

    const prices = await (await fetch(R('/api/prices'))).json();
    assert.equal(prices.prices.meituan.count, 2);
    assert.equal(prices.prices.meituan.offers.length, 2);

    // 集齐
    await fetch(R('/api/prices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'eleme', keyword: '麻辣香锅', offers: COLLECTED.eleme }),
    });
    const after = await (await fetch(R('/api/prices'))).json();
    assert.equal(after.progress.done, true, '两个平台都回传后应标记完成');
  });

  await ta('任务外的平台回传会被忽略', async () => {
    const r = await (await fetch(R('/api/prices'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform: 'jd', offers: [{ merchant: 'x', packages: [] }] }),
    })).json();
    assert.equal(r.ignored, true);
    const prices = await (await fetch(R('/api/prices'))).json();
    assert.equal(prices.prices.jd, undefined, '任务外的平台不该被写进价格表');
  });

  await ta('新一轮比价会清空上一轮价格（不复用缓存）', async () => {
    await fetch(R('/api/collect'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '日料', platforms: ['jd'] }),
    });
    const prices = await (await fetch(R('/api/prices'))).json();
    assert.equal(Object.keys(prices.prices).length, 0, '旧价格应被清空');
    assert.deepEqual(prices.progress.missing, ['jd']);
  });

  await ta('缺少参数时返回 400 而不是崩掉', async () => {
    const r1 = await fetch(R('/api/collect'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyword: '' }),
    });
    assert.equal(r1.status, 400);
    const r2 = await fetch(R('/api/prices'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offers: [] }),
    });
    assert.equal(r2.status, 400);
    const r3 = await fetch(R('/api/prices'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{坏 JSON',
    });
    assert.equal(r3.status, 400, '坏 JSON 不该让服务挂掉');
  });

  await ta('中继进程仍然活着（没被请求打挂）', async () => {
    assert.equal(relay.exitCode, null, `中继退出了，退出码 ${relay.exitCode}`);
    const j = await (await fetch(R('/api/health'))).json();
    assert.equal(j.ok, true);
  });
}

relay.kill();

/* ══════════ 3. 加权排名 ══════════ */
console.log('\n[3] 加权排名');

const offers = normalizeBatch(COLLECTED.meituan, 'meituan')
  .concat(normalizeBatch(COLLECTED.eleme, 'eleme'));
const candidates = [];
for (const o of offers) {
  for (const pk of o.packages) {
    candidates.push({
      platform: o.platform, merchant: o.merchant, rating: o.rating,
      reviewCount: o.reviewCount, good: o.good, bad: o.bad,
      package: pk, finalPrice: pk.finalPrice,
    });
  }
}

t('排名单调、分数在 0..1', () => {
  const ranked = scoreCandidates(candidates, parsed, structuredClone(DEFAULT_SETTINGS));
  assert.ok(ranked.length > 0);
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(ranked[i - 1].score >= ranked[i].score - 1e-9, '排序不是降序');
  }
  for (const c of ranked) {
    assert.ok(c.score >= 0 && c.score <= 1, `分数越界 ${c.score}`);
    assert.ok(c.rank >= 1);
    for (const k of ['price', 'discount', 'coupon', 'rating', 'credit', 'match', 'speed', 'member']) {
      assert.ok(Number.isFinite(c.scores[k]), `${k} 非数字`);
      assert.ok(c.scores[k] >= 0 && c.scores[k] <= 1, `${k} 越界 ${c.scores[k]}`);
    }
  }
});

t('把价格权重拉满，最便宜的应该赢', () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  s.weights = { price: 100, discount: 0, coupon: 0, rating: 0, credit: 0, match: 0, speed: 0, member: 0 };
  const ranked = scoreCandidates(candidates.map((c) => ({ ...c })), parsed, s);
  const cheapest = ranked.reduce((a, b) => (a.finalPrice <= b.finalPrice ? a : b));
  assert.equal(ranked[0].finalPrice, cheapest.finalPrice);
});

t('极致省钱标签会抬高价格权重', () => {
  const s = structuredClone(DEFAULT_SETTINGS);
  const withTag = scoreCandidates(candidates.map((c) => ({ ...c })), { ...parsed, tastes: ['value'] }, s);
  assert.ok(withTag[0].contrib.price > 0);
});

t('推荐理由非空且不含公式术语', () => {
  const ranked = scoreCandidates(candidates, parsed, structuredClone(DEFAULT_SETTINGS));
  const reasons = buildReasons(ranked[0], ranked, parsed);
  assert.ok(reasons.length >= 2, '理由太少');
  const joined = reasons.join('');
  assert.ok(!/权重|归一化|公式|系数/.test(joined), '理由里出现了术语：' + joined);
  assert.ok(/¥/.test(joined), '理由里应出现价格');
  assert.ok(buildQuotes(ranked[0]).length >= 1, '应抽到好评原句');
});

t('汇总统计正确', () => {
  const ranked = scoreCandidates(candidates, parsed, structuredClone(DEFAULT_SETTINGS));
  const s = summarize(ranked);
  assert.equal(s.count, ranked.length);
  assert.ok(s.min <= s.avg && s.avg <= s.max);
  assert.ok(s.platforms >= 2);
});

/* ══════════ 4. 费用估算 ══════════ */
console.log('\n[4] 费用估算');
t('按百万 token 单价估算', () => {
  const c = estimateCost({ tokensIn: 200, tokensOut: 40, priceIn: 1, priceOut: 2 });
  assert.ok(Math.abs(c - (200 / 1e6 * 1 + 40 / 1e6 * 2)) < 1e-12);
  assert.ok(c > 0 && c < 0.001, `一次转写应远低于一分钱，实际 ${c}`);
});

/* ══════════ 5. 保险箱 ══════════ */
console.log(`\n[5] 凭据保险箱（模式：${CRYPTO_MODE}）`);

await ta('加密写入后原文不落盘', async () => {
  const v = new Vault('test.vault');
  v._cache = { credentials: { meituan: { account: '13800000000', password: 'hunter2' } }, apiKey: 'sk-secret' };
  const ok = await v.save();
  assert.ok(ok, '写入失败');
  const raw = storage.get('test.vault');
  assert.ok(raw && raw.length > 0, '没写进去');
  assert.ok(!raw.includes('13800000000'), '手机号明文出现在存储里');
  assert.ok(!raw.includes('hunter2'), '密码明文出现在存储里');
  assert.ok(!raw.includes('sk-secret'), 'API Key 明文出现在存储里');
});

await ta('设备密钥可自动解回', async () => {
  const v2 = new Vault('test.vault');
  const ok = await v2.unlockDevice();
  assert.ok(ok, '自动解锁失败');
  assert.equal(v2.data().credentials.meituan.password, 'hunter2');
  assert.equal(v2.data().apiKey, 'sk-secret');
});

await ta('口令模式：错口令打不开，对口令能打开', async () => {
  const v = new Vault('test.pass.vault');
  v._cache = { credentials: { jd: { account: 'u1', password: 'p1' } } };
  const r = await v.setPassphrase('correct horse');
  assert.ok(r.ok, r.error);

  const bad = new Vault('test.pass.vault');
  assert.equal(await bad.unlockDevice(), false, '设了口令就不该能自动解锁');
  assert.equal(await bad.unlockPassphrase('wrong pass'), false, '错口令竟然打开了');
  assert.equal(await bad.unlockPassphrase('correct horse'), true, '对口令打不开');
  assert.equal(bad.data().credentials.jd.password, 'p1');
});

await ta('取消口令后恢复自动解锁', async () => {
  const v = new Vault('test.pass.vault');
  await v.unlockPassphrase('correct horse');
  const r = await v.setPassphrase(null, 'correct horse');
  assert.ok(r.ok, r.error);
  const v3 = new Vault('test.pass.vault');
  assert.equal(await v3.unlockDevice(), true, '取消口令后应能自动解锁');
  assert.equal(v3.data().credentials.jd.password, 'p1');
});

await ta('销毁后数据不可恢复', async () => {
  const v = new Vault('test.vault');
  await v.unlockDevice();
  v.destroy();
  assert.equal(v.exists(), false);
});

/* ══════════ 6. 设置读写 ══════════ */
console.log('\n[6] 设置读写');

await ta('Store 初始化并保存凭据', async () => {
  storage.clear();
  const s = new Store();
  await s.init();
  assert.ok(s.vaultReady);
  await s.setCredential('meituan', { account: 'a', password: 'b' });
  assert.equal(s.hasCredential('meituan'), true);
  await s.setApiKey('sk-abc');
  assert.equal(s.getApiKey(), 'sk-abc');

  // 重新加载 = 模拟下次打开
  const s2 = new Store();
  await s2.init();
  assert.equal(s2.getCredential('meituan').password, 'b', '重启后凭据丢失');
  assert.equal(s2.getApiKey(), 'sk-abc', '重启后 API Key 丢失');
});

await ta('设置深合并 + 版本迁移补齐', async () => {
  storage.clear();
  const s = new Store();
  await s.init();
  s.saveSettings({ llm: { enabled: true } });
  assert.equal(s.settings.llm.enabled, true);
  assert.equal(s.settings.llm.baseUrl, DEFAULT_SETTINGS.llm.baseUrl, '未改动的字段被清掉了');
  for (const p of PLATFORMS) assert.ok(s.settings.platforms[p.id], `缺平台 ${p.id}`);
});

await ta('用量累计与清零', async () => {
  storage.clear();
  const s = new Store();
  await s.init();
  s.recordUsage({ tokensIn: 200, tokensOut: 40, cost: 0.0003, model: 'm' });
  s.recordUsage({ tokensIn: 100, tokensOut: 20, cost: 0.0002, model: 'm' });
  assert.equal(s.todayUsage().calls, 2);
  assert.ok(Math.abs(s.todayUsage().cost - 0.0005) < 1e-9);
  s.clearUsage();
  assert.equal(s.todayUsage().calls, 0);
});

await ta('导出不含密钥 / 导入可还原设置', async () => {
  storage.clear();
  const s = new Store();
  await s.init();
  await s.setApiKey('sk-should-not-export');
  s.saveSettings({ tastes: ['light', 'soup'] });
  const text = s.exportData({ includeSecrets: false });
  assert.ok(!text.includes('sk-should-not-export'), '导出文件里带了 API Key');

  const s2 = new Store();
  await s2.init();
  const r = await s2.importData(text);
  assert.ok(r.ok, r.error);
  assert.deepEqual(s2.settings.tastes, ['light', 'soup']);
});

await ta('wipeAll 清空一切', async () => {
  storage.clear();
  const s = new Store();
  await s.init();
  await s.setCredential('jd', { account: 'x' });
  await s.setApiKey('sk-x');
  s.recordUsage({ tokensIn: 1, tokensOut: 1, cost: 1 });
  s.wipeAll();
  assert.equal(s.countSavedCredentials(), 0);
  assert.equal(s.hasApiKey(), false);
  assert.equal(s.usage.totalCalls, 0);
  assert.equal(s.storageBytes(), 0, '还有残留：' + s.storageBytes());
});

/* ══════════ 7. 插画匹配 ══════════ */
console.log('\n[7] 插画匹配');
const { pickArt, artSvg, ART_IDS } = await import('../web/js/art.js');

t('13 张插画全部内联', () => {
  assert.equal(ART_IDS.length, 13, `实际 ${ART_IDS.length} 张`);
});

t('关键词能选到对的插画', () => {
  const cases = [
    ['想吃牛肉面', 'dish-noodles'],
    ['来个汉堡', 'dish-burger'],
    ['想吃寿司', 'dish-sushi'],
    ['皮蛋瘦肉粥', 'dish-congee'],
    ['麻辣香锅', 'dish-crayfish'],
    ['火锅', 'dish-hotpot'],
    ['麻辣烫', 'dish-hotpot'],
    ['小龙虾', 'dish-crayfish'],
    ['沙拉减脂', 'dish-salad'],
    ['奶茶', 'dish-dessert'],
    ['披萨', 'dish-pizza'],
    ['饺子', 'dish-dumpling'],
    ['烤串', 'dish-bbq'],
    ['盖饭', 'dish-rice'],
  ];
  for (const [q, expect] of cases) {
    const p = extractBuiltin(q);
    const art = pickArt({ keywords: p.keywords, kinds: p.kinds, raw: q });
    assert.equal(art, expect, `「${q}」→ ${art}，期望 ${expect}`);
  }
});

t('无从判断时兜底 default', () => {
  assert.equal(pickArt({ keywords: ['嗯嗯嗯'], raw: '嗯嗯嗯' }), 'dish-default');
});

t('渲染出的 SVG 合法且含无障碍标签', () => {
  const svg = artSvg('dish-noodles', { label: '面食' });
  assert.ok(svg.startsWith('<svg'), '不是 svg');
  assert.ok(svg.includes('aria-label="面食"'));
  assert.ok(svg.trim().endsWith('</svg>'));
  const open = (svg.match(/</g) || []).length;
  assert.ok(open > 3);
  assert.ok(!/<script/i.test(svg), 'SVG 里不该有 script');
});

/* ══════════ 汇总 ══════════ */
console.log(`\n${'─'.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
