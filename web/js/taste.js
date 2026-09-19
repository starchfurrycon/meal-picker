/**
 * 内置轻量语义转写
 *
 * 目标：把"想吃点辣的但是别太贵，最好有汤"这类模糊描述，拆成
 *      可以直接拿去平台搜索的关键词 + 结构化约束。
 * 完全离线、零成本、零依赖，毫秒级返回。
 */

import { CUISINE_KINDS, TASTES } from './catalog.js';

/** 同义词 → 标准品类 */
const KIND_LEXICON = {
  noodles: ['面', '拉面', '牛肉面', '面条', '米线', '米粉', '粉', '意面', '拌面', '凉面', '刀削面', '烩面', '螺蛳粉', '肥肠粉', '酸辣粉'],
  rice: ['饭', '盖饭', '盖浇饭', '炒饭', '煲仔饭', '拌饭', '咖喱饭', '便当', '快餐', '家常菜', '小炒', '套餐饭'],
  burger: ['汉堡', '炸鸡', '薯条', '披萨以外的西式', '快餐', '鸡块', '鸡翅', '可乐套餐', 'kfc', '麦当劳', '华莱士'],
  pizza: ['披萨', '比萨', 'pizza', '意式', '千层面', '焗饭'],
  hotpot: ['火锅', '麻辣烫', '冒菜', '串串', '小火锅', '关东煮', '钵钵鸡', '毛血旺'],
  bbq: ['烧烤', '烤串', '串', '烤肉', '烤鱼', '铁板', '炭火', '烤冷面'],
  dumpling: ['饺子', '水饺', '蒸饺', '锅贴', '小笼', '包子', '烧麦', '馄饨', '云吞'],
  sushi: ['寿司', '日料', '刺身', '生鱼片', '鳗鱼', '照烧', '天妇罗', '拉面以外的日式', '定食'],
  salad: ['沙拉', '轻食', '健康餐', '减脂餐', '低卡', '能量碗', '藜麦', '鸡胸肉', '健身餐', '荞麦'],
  dessert: ['甜品', '奶茶', '蛋糕', '冰淇淋', '布丁', '芋泥', '杨枝甘露', '舒芙蕾', '糖水', '慕斯'],
  congee: ['粥', '汤', '羹', '砂锅', '养生', '炖', '煲汤', '老火'],
  crayfish: ['小龙虾', '龙虾', '海鲜', '蟹', '香锅', '干锅', '扇贝', '生蚝', '花甲'],
};

/** 口味/约束 关键词 */
const TASTE_LEXICON = {
  spicy: ['辣', '麻辣', '香辣', '重口', '够味', '川', '湘', '椒', '剁椒', '水煮'],
  light: ['清淡', '少油', '少盐', '不辣', '蒸', '白灼', '原味', '清爽'],
  lowcal: ['减脂', '低卡', '控卡', '热量', '瘦', '健身', '轻食', '控糖', '无糖', '健康'],
  meat: ['肉', '牛肉', '猪肉', '鸡腿', '排骨', '羊', '牛排', '大份', '管饱', '实在'],
  noodle: ['面', '粉', '米线'],
  rice: ['饭', '米'],
  soup: ['汤', '粥', '羹', '煲', '热乎', '暖'],
  sweet: ['甜', '甜品', '奶茶', '蛋糕', '糖'],
  seafood: ['虾', '蟹', '海鲜', '鱼', '贝', '生蚝'],
  value: ['便宜', '省钱', '划算', '实惠', '性价比', '预算', '别太贵', '不贵', '学生', '穷'],
};

/** 中文数字 / 阿拉伯数字金额 */
const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function parseAmount(s) {
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  // 三十 / 二十五 / 十
  let total = 0, section = 0;
  for (const ch of s) {
    if (ch === '十') section = (section || 1) * 10;
    else if (CN_NUM[ch] !== undefined) section = (section ? section : 0) + CN_NUM[ch];
    else return null;
  }
  total += section;
  return total || null;
}

const NUM = '(\\d+(?:\\.\\d+)?|[零一两二三四五六七八九十]+)';

const BUDGET_PATTERNS = [
  new RegExp(`${NUM}\\s*(?:块|元|rmb|￥|¥)\\s*(?:以内|以下|左右|内|封顶|上限)?`),
  new RegExp(`(?:预算|不超过|最多|别超过|控制在|上限|封顶)\\s*${NUM}\\s*(?:块|元)?`),
  new RegExp(`${NUM}\\s*(?:块|元)?\\s*(?:以内|以下|左右)`),
];

/** 数量 / 人数 */
function parseParty(text) {
  if (/(一个人|一人|自己吃|单人|就我)/.test(text)) return 1;
  const m = text.match(new RegExp(`${NUM}\\s*(?:个)?\\s*(?:人|位)`));
  if (m) return parseAmount(m[1]) || null;
  if (/(两个人|两人|双人|情侣)/.test(text)) return 2;
  if (/(三个人|三人)/.test(text)) return 3;
  if (/(四个人|四人|全家)/.test(text)) return 4;
  return null;
}

/** 忌口 */
const AVOID_LEXICON = [
  { kw: ['不要香菜', '不吃香菜', '香菜'], out: '香菜' },
  { kw: ['不要葱', '不吃葱'], out: '葱' },
  { kw: ['不要蒜', '不吃蒜'], out: '蒜' },
  { kw: ['不要辣', '不吃辣', '不能吃辣'], out: '辣' },
  { kw: ['不吃牛', '不吃牛肉'], out: '牛肉' },
  { kw: ['不吃猪', '不吃猪肉'], out: '猪肉' },
  { kw: ['不吃海鲜', '海鲜过敏'], out: '海鲜' },
  { kw: ['不吃内脏'], out: '内脏' },
  { kw: ['素食', '吃素'], out: '荤食' },
];

/** 时段 */
function parseTime(text) {
  if (/(早餐|早上|早晨)/.test(text)) return 'breakfast';
  if (/(夜宵|宵夜|半夜|晚上吃)/.test(text)) return 'late';
  if (/(下午茶|下午)/.test(text)) return 'snack';
  if (/(午餐|中午|午饭)/.test(text)) return 'lunch';
  if (/(晚餐|晚上|晚饭)/.test(text)) return 'dinner';
  return null;
}

/**
 * 主入口
 * @param {string} text 用户输入
 * @returns {{keywords:string[], kinds:string[], tastes:string[], budget:number|null, party:number|null, avoid:string[], time:string|null, raw:string, source:'builtin'}}
 */
export function extractBuiltin(text) {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();

  /* 品类命中：双字以上算强信号，单字只作兜底
     （"一个人吃"里的"人"、"别太贵"里的"贵"这类噪音必须排除） */
  const strong = {};
  const weak = {};
  for (const [kind, words] of Object.entries(KIND_LEXICON)) {
    let s = 0;
    for (const w of words) {
      if (!t.includes(w.toLowerCase())) continue;
      if (w.length >= 2) s += w.length >= 3 ? 3 : 2;
    }
    if (s) strong[kind] = s;
  }
  let kinds;
  if (Object.keys(strong).length) {
    kinds = Object.entries(strong).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  } else {
    for (const [kind, words] of Object.entries(KIND_LEXICON)) {
      let s = 0;
      for (const w of words) {
        if (w.length === 1 && t.includes(w)) s += 1;
      }
      if (s) weak[kind] = s;
    }
    const weakSorted = Object.entries(weak).sort((a, b) => b[1] - a[1]);
    // 单字命中已排除"人/贵/吃"这类噪音（它们不在品类词典里），
    // 只要命中一个就认；完全没命中则判定为"没识别出具体品类"。
    kinds = weakSorted.map(([k]) => k);
  }

  /* 口味标签 */
  const tastes = [];
  for (const [taste, words] of Object.entries(TASTE_LEXICON)) {
    if (words.some((w) => t.includes(w.toLowerCase()))) tastes.push(taste);
  }
  // 用户勾选的口味由设置层补充，这里只做文本识别

  /* 预算 */
  let budget = null;
  for (const re of BUDGET_PATTERNS) {
    const m = raw.match(re);
    if (m) {
      const v = parseAmount(m[1]);
      if (v && v >= 5 && v <= 2000) { budget = v; break; }
    }
  }

  /* 忌口 */
  const avoid = [];
  for (const item of AVOID_LEXICON) {
    if (item.kw.some((k) => t.includes(k.toLowerCase()))) avoid.push(item.out);
  }
  // "不要辣" 与 "想吃辣" 冲突时，忌口优先，同时移除辣味标签
  if (avoid.includes('辣')) {
    const i = tastes.indexOf('spicy');
    if (i >= 0) tastes.splice(i, 1);
  }

  const party = parseParty(raw);
  const time = parseTime(raw);

  /* ── 生成搜索关键词 ── */
  const keywords = [];
  const push = (k) => { const s = String(k).trim(); if (s && !keywords.includes(s)) keywords.push(s); };

  const kindMeta = kinds.map((id) => CUISINE_KINDS.find((c) => c.id === id)).filter(Boolean);

  // 1) 从原文里抠出"实体词"：连续中文 2-6 字里包含品类词的片段
  const entityHits = [];
  for (const [kind, words] of Object.entries(KIND_LEXICON)) {
    for (const w of words) {
      if (w.length >= 2 && t.includes(w.toLowerCase())) entityHits.push({ kind, w });
    }
  }
  entityHits.sort((a, b) => b.w.length - a.w.length);

  // 2) 品类代表词作为关键词（命中率最高的搜索词）
  if (kindMeta.length) {
    for (const km of kindMeta.slice(0, 2)) {
      push(km.sample || km.label);
      push(km.label);
    }
  }

  // 3) 口味前缀组合
  const tasteWord = {
    spicy: '麻辣', light: '清淡', lowcal: '低卡', meat: '大份',
    soup: '汤', sweet: '甜品', seafood: '海鲜', value: '实惠',
  };
  const prefix = tastes.map((x) => tasteWord[x]).filter(Boolean)[0];
  if (prefix && kindMeta.length) push(`${prefix}${kindMeta[0].label}`);

  // 4) 原文里的直接名词（长度 2–6 的连续中文，去掉语气词与描述性短语）
  const STOP = /^(想吃|想喝|来点|来份|今天|有点|一些|一点|最好|但是|不过|可以|不要|不吃|别太|太贵|的话|什么|怎么|帮我|推荐|感觉|好像|其实|就是|随便|都行|也行|算了|吧|呢|啊|呀|哦|了|的|吃|喝|点|个|份|碗|盘|家|店)$/;
  const DESC = /(别太|太贵|最好|但是|不过|可是|有点|一些|一点|可以|不要|不吃|不要|想吃|想喝|来点|来份|帮我|推荐|随便|都行|也行|的话|感觉|好像|其实)/;
  const chunks = raw.match(/[\u4e00-\u9fa5]{2,6}/g) || [];
  for (const c of chunks) {
    if (STOP.test(c) || DESC.test(c)) continue;
    // 含品类词或口味词的片段优先
    const hasKind = Object.values(KIND_LEXICON).some((ws) => ws.some((w) => w.length >= 2 && c.includes(w)));
    const hasTaste = Object.values(TASTE_LEXICON).some((ws) => ws.some((w) => w.includes(c)));
    if (hasKind || hasTaste) push(c);
  }

  // 5) 兜底：说不出具体菜名时，也要给出**能搜到东西**的词，而不是把整句话丢进搜索框
  if (!keywords.length) {
    const kindPool = kindMeta.length ? kindMeta : CUISINE_KINDS;
    const spicyish = tastes.includes('spicy');
    const valueish = tastes.includes('value');
    const lightish = tastes.includes('light') || tastes.includes('lowcal') || tastes.includes('soup');

    if (spicyish) {
      push('麻辣香锅');
      push('水煮肉片');
      push('麻辣烫');
    } else if (lightish) {
      push('清淡套餐');
      push('砂锅粥');
      push('轻食沙拉');
    } else if (valueish) {
      push('实惠套餐');
      push('双拼盖饭');
      push('招牌牛肉面');
    }
    if (kindMeta.length) {
      for (const km of kindMeta.slice(0, 2)) {
        push(km.sample || km.label);
        push(km.label);
      }
    } else {
      push(kindPool[0].sample || kindPool[0].label);
      push(kindPool[0].label);
    }
    push('热门套餐');
  }

  // 6) 关键词清洗：过短补全、去重、限量
  if (keywords[0].length <= 2) keywords[0] = `${keywords[0]}套餐`;
  const cleaned = keywords
    .map((k) => k.replace(/[，,。！!？?、\s]+$/g, '').slice(0, 12))
    .filter((k) => k.length >= 2);
  keywords.length = 0;
  keywords.push(...cleaned);

  return {
    keywords: keywords.slice(0, 5),
    kinds: kinds.slice(0, 3),
    tastes: Array.from(new Set(tastes)),
    budget,
    party,
    avoid,
    time,
    raw,
    source: 'builtin',
  };
}

/** 把用户勾选的口味合并进解析结果 */
export function mergePrefs(parsed, settings) {
  const tastes = new Set(parsed.tastes || []);
  for (const t of settings.tastes || []) tastes.add(t);
  const out = { ...parsed, tastes: Array.from(tastes) };
  if (settings.budget?.enabled && settings.budget.max) {
    out.budget = out.budget ? Math.min(out.budget, settings.budget.max) : settings.budget.max;
  }
  return out;
}

/** 命中 TASTES 描述的展示文案 */
export function tasteLabels(ids) {
  return (ids || []).map((id) => TASTES.find((t) => t.id === id)?.label).filter(Boolean);
}
