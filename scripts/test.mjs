/**
 * 冒烟测试：在 Node 里跑通核心链路（不依赖浏览器）
 *
 *   node scripts/test.mjs
 *
 * 覆盖：内置语义转写 → 演示数据源搜索 → 加权排名 → 推荐理由
 *      凭据保险箱加密/解密/口令模式 → 设置读写
 */

import assert from 'node:assert/strict';

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
const { searchAll, resolveSource, demoPlatformSearch } = await import('../web/js/adapters.js');
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

/* ══════════ 2. 演示数据源 ══════════ */
console.log('\n[2] 数据源');

const settings = structuredClone(DEFAULT_SETTINGS);
settings.platforms.meituan.enabled = true;
settings.platforms.eleme.enabled = true;
settings.platforms.jd.enabled = true;
settings.platforms.taobao.enabled = true;

const parsed = extractBuiltin('想吃点辣的但是别太贵，一个人吃，40以内');

t('确定性：同参数两次结果一致', () => {
  const a = demoPlatformSearch('meituan', parsed, settings, {}, 0);
  const b = demoPlatformSearch('meituan', parsed, settings, {}, 0);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

t('换一批会变（salt 生效）', () => {
  const a = demoPlatformSearch('meituan', parsed, settings, {}, 0);
  const b = demoPlatformSearch('meituan', parsed, settings, {}, 1);
  assert.notEqual(JSON.stringify(a), JSON.stringify(b));
});

t('结构完整、价格自洽', () => {
  const offers = demoPlatformSearch('meituan', parsed, settings, {}, 0);
  assert.ok(offers.length >= 4, '商家太少');
  for (const o of offers) {
    assert.ok(o.merchant && o.merchant.length >= 2, '店名为空');
    assert.ok(o.rating >= 3.5 && o.rating <= 5, `评分越界 ${o.rating}`);
    assert.ok(o.good.length >= 2, '好评不足');
    for (const p of o.packages) {
      assert.ok(p.finalPrice > 0, '价格非正');
      assert.ok(p.basePrice >= p.finalPrice, `原价 ${p.basePrice} < 到手 ${p.finalPrice}`);
      assert.ok(p.etaMin >= 12 && p.etaMin <= 75, `时长越界 ${p.etaMin}`);
      const dealSum = p.deals.reduce((s, d) => s + d.amount, 0);
      const expect = Math.max(1, Math.round((p.basePrice - dealSum + p.shippingFee + p.packingFee) * 100) / 100);
      assert.ok(Math.abs(expect - p.finalPrice) < 0.02, `价格计算不符：${expect} vs ${p.finalPrice}`);
      assert.ok(p.art && p.art.length > 0, '缺插画 id');
    }
  }
});

t('数据源解析：auto + 无接口 → demo', () => {
  assert.equal(resolveSource({ mode: 'auto', endpoint: '', demo: true }, 'meituan'), 'demo');
  assert.equal(resolveSource({ mode: 'auto', endpoint: 'https://x/y', demo: true }, 'meituan'), 'custom');
  assert.equal(resolveSource({ mode: 'auto', endpoint: '', demo: false }, 'meituan'), 'none');
  assert.equal(resolveSource({ mode: 'demo', endpoint: 'https://x/y', demo: false }, 'meituan'), 'demo');
  assert.equal(resolveSource({ mode: 'custom', endpoint: '', demo: false }, 'meituan'), 'none');
});

await ta('searchAll 并发取回多平台', async () => {
  const r = await searchAll({ parsed, settings, credentials: {}, salt: 0 });
  assert.equal(r.offers.length, 4 * 4, `4 个平台 × 4 家店，实际 ${r.offers.length}`);
  assert.equal(new Set(r.offers.map((o) => o.platform)).size, 4);
  assert.ok(r.notes.every((n) => !n.error), '不应有错误');
});

/* ══════════ 3. 加权排名 ══════════ */
console.log('\n[3] 加权排名');

const { offers } = await searchAll({ parsed, settings, credentials: {}, salt: 0 });
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
