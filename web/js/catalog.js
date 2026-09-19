/**
 * 目录数据：平台定义、口味标签、加权因子、以及内置演示数据源的语料。
 *
 * ⚠️ 关于商家名：下列店名均为**虚构**名称（如"川小满""椒盐记"），
 *    不与任何真实商家对应。演示数据源用它生成占位结果，避免误导。
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
    blurb: '京东秒送 / 七鲜 · 品质与时效稳定',
    loginFields: [
      { key: 'account', label: '账号', placeholder: '手机号 / 京东账号', type: 'text' },
      { key: 'password', label: '登录密码', placeholder: '仅本地加密保存', type: 'password', secret: true },
    ],
    options: ['PLUS 会员'],
    search: (kw) => `https://search.jd.com/Search?keyword=${encodeURIComponent(kw)}`,
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
      { key: 'account', label: '账号', placeholder: '手机号 / 美团账号', type: 'text' },
      { key: 'password', label: '登录密码', placeholder: '仅本地加密保存', type: 'password', secret: true },
    ],
    options: ['美团神会员', '开通外卖会员'],
    search: (kw) => `https://waimai.meituan.com/search?keyword=${encodeURIComponent(kw)}`,
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
      { key: 'account', label: '账号', placeholder: '手机号 / 淘宝账号', type: 'text' },
      { key: 'password', label: '登录密码', placeholder: '仅本地加密保存', type: 'password', secret: true },
    ],
    options: ['88VIP'],
    search: (kw) => `https://s.taobao.com/search?q=${encodeURIComponent(kw)}`,
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
      { key: 'account', label: '账号', placeholder: '手机号 / 饿了么账号', type: 'text' },
      { key: 'password', label: '登录密码', placeholder: '仅本地加密保存', type: 'password', secret: true },
    ],
    options: ['超级吃货卡'],
    search: (kw) => `https://www.ele.me/search?keyword=${encodeURIComponent(kw)}`,
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

/* ══════════════ 演示语料 ══════════════ */
export const CUISINE_KINDS = [
  { id: 'noodles', art: 'noodles', label: '面食', price: [16, 34], packs: ['招牌牛肉面', '番茄鸡蛋面', '酸辣米线', '葱油拌面', '雪菜肉丝面'] },
  { id: 'rice', art: 'rice', label: '米饭', price: [18, 38], packs: ['双拼盖饭', '黑椒鸡排饭', '梅菜扣肉饭', '咖喱牛肉饭', '腊味煲仔饭'] },
  { id: 'burger', art: 'burger', label: '西式快餐', price: [22, 45], packs: ['双层牛肉堡套餐', '香辣鸡腿堡套餐', '炸鸡桶单人餐', '芝士脆薯堡套餐'] },
  { id: 'pizza', art: 'pizza', label: '披萨', price: [39, 78], packs: ['玛格丽特披萨', '奥尔良鸡肉披萨', '榴莲芝士披萨', '至尊双拼披萨'] },
  { id: 'hotpot', art: 'hotpot', label: '麻辣烫', price: [20, 46], packs: ['自选麻辣烫', '番茄牛腩冒菜', '酸辣粉小火锅', '冒菜双人份'] },
  { id: 'bbq', art: 'bbq', label: '烧烤', price: [28, 68], packs: ['招牌烤串拼盘', '孜然羊肉串套餐', '烤五花肉套餐', '锡纸金针菇套餐'] },
  { id: 'dumpling', art: 'dumpling', label: '饺子', price: [16, 36], packs: ['三鲜水饺', '猪肉白菜蒸饺', '鲜肉小笼包', '锅贴套餐'] },
  { id: 'sushi', art: 'sushi', label: '日料', price: [35, 88], packs: ['三文鱼刺身拼盘', '寿司双人套餐', '鳗鱼饭定食', '照烧鸡腿饭定食'] },
  { id: 'salad', art: 'salad', label: '轻食', price: [22, 48], packs: ['鸡胸肉能量碗', '牛油果藜麦沙拉', '三文鱼轻食碗', '低卡荞麦冷面'] },
  { id: 'dessert', art: 'dessert', label: '甜品', price: [14, 36], packs: ['芋泥波波奶茶', '杨枝甘露', '提拉米苏切块', '舒芙蕾松饼'] },
  { id: 'congee', art: 'congee', label: '粥汤', price: [14, 32], packs: ['皮蛋瘦肉粥', '砂锅海鲜粥', '山药排骨汤', '菌菇养生汤'] },
  { id: 'crayfish', art: 'crayfish', label: '香锅海鲜', price: [45, 128], packs: ['十三香小龙虾', '蒜蓉小龙虾', '麻辣香锅套餐', '香辣蟹双人餐'] },
];

export const MERCHANT_PREFIX = [
  '川小满', '椒盐记', '一勺半', '食野', '灶前', '三分饱', '禾下有食', '巷口',
  '小满食堂', '半碗', '云间', '拾味', '知味', '南屏', '巷尾', '饭小圈',
  '慢炖', '煮意', '白露', '禾风', '小灶', '热气', '谷禾', '简食',
];
export const MERCHANT_SUFFIX = [
  '小馆', '食堂', '厨房', '食铺', '工坊', '料理', '家常菜', '轻食研究所',
  '手作', 'station', '小灶', '灶台', '食集',
];

export const REVIEW_POOL = [
  { text: '分量是真的足，一个人吃撑了', tag: '份量足' },
  { text: '出餐快，到手还是烫的', tag: '出餐快' },
  { text: '味道稳定，回购第 N 次了', tag: '稳定' },
  { text: '包装很稳，一点没洒', tag: '包装好' },
  { text: '老板多送了一份小菜，很贴心', tag: '贴心' },
  { text: '肉给得多，不是那种薄薄两片', tag: '料足' },
  { text: '辣度刚好，够味但不烧胃', tag: '辣度合适' },
  { text: '汤底浓郁，喝到最后都不腻', tag: '汤底好' },
  { text: '蔬菜新鲜，没有蔫的', tag: '新鲜' },
  { text: '比店里堂食便宜，划算', tag: '划算' },
  { text: '连续点了两周，没有踩雷', tag: '零踩雷' },
  { text: '客服响应很快，漏了筷子马上补', tag: '售后好' },
  { text: '饭是粒粒分明的，不是糊成一团', tag: '米饭好' },
  { text: '性价比在这个价位里很难找到对手', tag: '性价比高' },
  { text: '微微有点咸，但整体很香', tag: '偏咸' },
  { text: '份量对女生刚好，男生可能不太够', tag: '份量偏小' },
];

export const BAD_REVIEW_POOL = [
  { text: '等了一个多小时才到，饿过头了', tag: '超时' },
  { text: '到手有点凉了，微波炉热了一下', tag: '偏凉' },
  { text: '分量比图片少一些', tag: '图文有差' },
  { text: '口味偏咸，可能是我口轻', tag: '偏咸' },
];

export const DEAL_TEMPLATES = [
  { kind: 'discount', label: (v) => `${v} 折`, rate: [0.72, 0.94] },
  { kind: 'coupon', label: (v) => `满 ${v[0]} 减 ${v[1]}`, coupon: [[20, 5], [30, 8], [40, 12], [50, 15], [60, 20]] },
  { kind: 'freeship', label: () => '免配送费', amount: [3, 7] },
  { kind: 'member', label: () => '会员价', amount: [2, 8] },
  { kind: 'newcomer', label: () => '新客立减', amount: [6, 15] },
];

export const PLATFORM_TRAITS = {
  jd: { priceBias: 1.06, couponBias: 0.9, speedBias: 0.88, ratingBias: 1.04, creditBias: 1.08 },
  meituan: { priceBias: 0.99, couponBias: 1.05, speedBias: 1.0, ratingBias: 1.0, creditBias: 1.0 },
  taobao: { priceBias: 0.97, couponBias: 1.15, speedBias: 1.06, ratingBias: 0.98, creditBias: 0.97 },
  eleme: { priceBias: 0.95, couponBias: 1.12, speedBias: 1.02, ratingBias: 1.01, creditBias: 1.02 },
};

/* ══════════════ 设置默认值 ══════════════ */
export const DEFAULT_SETTINGS = {
  version: 1,
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
    mode: 'auto',            // auto | demo | custom
    endpoint: '',
    demo: true,              // 没有真实接口时使用内置演示数据
    allowRemoteImages: false,
    timeoutMs: 8000,
  },
  ui: {
    keepCredentials: true,
    compact: false,
  },
};
