/**
 * 目录数据：平台定义、口味标签、加权因子。
 *
 * 这里不含任何商家名或价格语料 —— 价格一律来自实时采集或用户自备的接口。
 * CUISINE_KINDS 只用于把一句话里的品类词识别出来（如"想吃面" → noodles），
 * 其中的 label 会出现在关键词里，price / packs 仅供口味匹配参考，不参与报价。
 */

/* ══════════════ 平台 ══════════════ */
export const PLATFORMS = [
  {
    id: 'jd',
    name: '京东',
    short: '京东',
    color: '#E1251B',
    tint: 'rgba(225,37,27,.10)',
    line: 'rgba(225,37,27,.28)',
    blurb: '京东秒送 · 品质与时效稳定',
    loginFields: [
      { key: 'account', label: '账号', placeholder: '手机号 / 京东账号（仅作备注）', type: 'text' },
    ],
    options: ['PLUS 会员'],
    search: (kw) => `https://search.jd.com/Search?keyword=${encodeURIComponent(kw)}`,
    order: (name) => `https://search.jd.com/Search?keyword=${encodeURIComponent(name)}`,
    shippingHint: '通常满 49 免运费',
  },
  {
    id: 'meituan',
    name: '美团',
    short: '美团',
    color: '#FFC300',
    tint: 'rgba(255,195,0,.16)',
    line: 'rgba(255,195,0,.42)',
    blurb: '外卖主力 · 商家覆盖最广',
    loginFields: [
      { key: 'account', label: '账号', placeholder: '手机号 / 美团账号（仅作备注）', type: 'text' },
    ],
    options: ['美团神会员', '开通外卖会员'],
    search: (kw) => `https://waimai.meituan.com/search?keyword=${encodeURIComponent(kw)}`,
    order: (name) => `https://waimai.meituan.com/search?keyword=${encodeURIComponent(name)}`,
    shippingHint: '配送费普遍 2–6 元',
  },
  {
    id: 'taobao',
    name: '淘宝闪购',
    short: '闪购',
    color: '#FF5000',
    tint: 'rgba(255,80,0,.10)',
    line: 'rgba(255,80,0,.28)',
    blurb: '小时达 / 淘鲜达 · 券多、活动密',
    loginFields: [
      { key: 'account', label: '账号', placeholder: '手机号 / 淘宝账号（仅作备注）', type: 'text' },
    ],
    options: ['88VIP'],
    search: (kw) => `https://s.taobao.com/search?q=${encodeURIComponent(kw)}`,
    order: (name) => `https://s.taobao.com/search?q=${encodeURIComponent(name)}`,
    shippingHint: '闪购多含配送费，注意门槛',
  },
  {
    id: 'eleme',
    name: '饿了么',
    short: '饿了么',
    color: '#1E90FF',
    tint: 'rgba(30,144,255,.10)',
    line: 'rgba(30,144,255,.28)',
    blurb: '红包力度大 · 会员卡划算',
    loginFields: [
      { key: 'account', label: '账号', placeholder: '手机号 / 饿了么账号（仅作备注）', type: 'text' },
    ],
    options: ['超级吃货卡'],
    search: (kw) => `https://www.ele.me/search?keyword=${encodeURIComponent(kw)}`,
    order: (name) => `https://www.ele.me/search?keyword=${encodeURIComponent(name)}`,
    shippingHint: '满减门槛较低',
  },
];

export const platformById = (id) => PLATFORMS.find((p) => p.id === id) || null;

/* ══════════════ 口味标签 ══════════════ */
export const TASTES = [
  { id: 'spicy', label: '嗜辣', desc: '优先带辣度标注的套餐', words: ['辣', '麻辣', '香辣', '川', '湘', '椒'] },
  { id: 'light', label: '清淡', desc: '少油少盐、汤粥类', words: ['清淡', '少油', '蒸', '粥', '汤', '白灼'] },
  { id: 'lowcal', label: '控卡减脂', desc: '优先轻食与低热量', words: ['减脂', '低卡', '轻食', '沙拉', '健身', '控糖'] },
  { id: 'meat', label: '无肉不欢', desc: '大份量肉类优先', words: ['肉', '烤肉', '牛排', '排骨', '鸡腿', '牛肉'] },
  { id: 'noodle', label: '面食党', desc: '面、粉、米线', words: ['面', '粉', '米线', '拉面', '拌面'] },
  { id: 'rice', label: '米饭党', desc: '盖饭、炒饭、家常菜', words: ['饭', '盖饭', '炒饭', '煲仔'] },
  { id: 'soup', label: '爱喝汤', desc: '汤类与粥品', words: ['汤', '粥', '羹', '煲'] },
  { id: 'sweet', label: '甜口', desc: '甜品与奶茶', words: ['甜', '蛋糕', '奶茶', '布丁', '芋'] },
  { id: 'seafood', label: '海鲜控', desc: '虾蟹贝类', words: ['虾', '蟹', '海鲜', '贝', '鱼'] },
  { id: 'value', label: '极致省钱', desc: '价格权重自动拉满', words: ['便宜', '省钱', '划算', '预算', '实惠'] },
];

/* ══════════════ 加权因子 ══════════════ */
/**
 * 默认权重（会自动归一化到 100%）
 * 每个因子的归一化方式在 engine.js 中定义
 */
export const FACTORS = [
  { id: 'price', label: '到手价', desc: '实付越低越好', weight: 26 },
  { id: 'discount', label: '折扣力度', desc: '原价与折扣的落差', weight: 18 },
  { id: 'coupon', label: '优惠券', desc: '可用券与满减额度', weight: 12 },
  { id: 'rating', label: '商家评分', desc: '店铺综合评分', weight: 14 },
  { id: 'credit', label: '商家诚信', desc: '评价真实度与经营稳定度', weight: 10 },
  { id: 'match', label: '口味匹配', desc: '与你这句需求的贴合度', weight: 10 },
  { id: 'speed', label: '送达速度', desc: '预计配送时长', weight: 6 },
  { id: 'member', label: '会员权益', desc: '会员价与专属券', weight: 4 },
];

export const DEFAULT_WEIGHTS = Object.fromEntries(FACTORS.map((f) => [f.id, f.weight]));

/* ══════════════ 品类词表（只用于理解一句话，不参与报价） ══════════════ */
/** sample 是"这个品类可以拿去搜的具体词"，不是价格数据 */
export const CUISINE_KINDS = [
  { id: 'noodles', art: 'noodles', label: '面食', sample: '招牌牛肉面' },
  { id: 'rice', art: 'rice', label: '米饭', sample: '双拼盖饭' },
  { id: 'burger', art: 'burger', label: '西式快餐', sample: '汉堡套餐' },
  { id: 'pizza', art: 'pizza', label: '披萨', sample: '披萨' },
  { id: 'hotpot', art: 'hotpot', label: '麻辣烫', sample: '麻辣烫' },
  { id: 'bbq', art: 'bbq', label: '烧烤', sample: '烤串套餐' },
  { id: 'dumpling', art: 'dumpling', label: '饺子', sample: '水饺' },
  { id: 'sushi', art: 'sushi', label: '日料', sample: '寿司套餐' },
  { id: 'salad', art: 'salad', label: '轻食', sample: '轻食沙拉' },
  { id: 'dessert', art: 'dessert', label: '甜品', sample: '甜品' },
  { id: 'congee', art: 'congee', label: '粥汤', sample: '砂锅粥' },
  { id: 'crayfish', art: 'crayfish', label: '香锅海鲜', sample: '麻辣香锅' },
];

/* ══════════════ 设置默认值 ══════════════ */
export const DEFAULT_SETTINGS = {
  version: 2,
  platforms: Object.fromEntries(PLATFORMS.map((p) => [p.id, { enabled: p.id === 'meituan' || p.id === 'eleme', options: {} }])),
  tastes: ['spicy'],
  budget: { enabled: false, max: 40 },
  weights: { ...DEFAULT_WEIGHTS },
  llm: {
    enabled: false,
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    temperature: 0.2,
    priceIn: 1,      // 元 / 百万 token
    priceOut: 2,     // 元 / 百万 token
    showCost: true,
  },
  dataSource: {
    mode: 'realtime',        // realtime | custom | none | auto
    endpoint: '',
    relayPort: 8765,
    timeoutMs: 45000,
    openTabs: 'visible',     // visible | background
  },
  ui: {
    keepCredentials: true,
    compact: false,
  },
};
