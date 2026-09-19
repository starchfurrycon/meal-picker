/**
 * 设置面板
 * 四个分页：平台 / 口味 / 智能转写 / 隐私
 */

import { PLATFORMS, TASTES, FACTORS, DEFAULT_WEIGHTS } from './catalog.js';
import { SOURCES } from './adapters.js';
import { probeRelay, DEFAULT_RELAY_PORT } from './realtime.js';
import { $, el, icon, money, clamp } from './util.js';
import {
  openSheet, closeSheet, toast, switchEl, field, textInput, passwordInput,
  note, checkRow, collapsible, slider,
} from './ui.js';
import { llmPing } from './llm.js';
import { CRYPTO_MODE } from './crypto.js';

let store = null;
let activeTab = 'platforms';
let refreshHome = () => {};

export function initSettings(storeRef, { onHomeRefresh } = {}) {
  store = storeRef;
  refreshHome = onHomeRefresh || (() => {});
  $('#open-settings').addEventListener('click', () => openSettings());
  $('#close-settings').addEventListener('click', () => closeSheet());
  $('.sheet__scrim').addEventListener('click', () => closeSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSheet();
  });
  store.onChange(() => { if (!$('#sheet').hidden) renderSheet(); });
}

export function openSettings(tab) {
  if (tab) activeTab = tab;
  renderSheet();
  openSheet();
}

/* ══════════════ 渲染 ══════════════ */

function renderSheet() {
  const body = $('#sheet-body');
  body.replaceChildren();
  const tabs = $('#tabs');
  Array.from(tabs.children).forEach((t) => t.classList.toggle('is-on', t.dataset.tab === activeTab));
  Array.from(tabs.children).forEach((t) => {
    if (t._bound) return;
    t._bound = true;
    t.addEventListener('click', () => { activeTab = t.dataset.tab; renderSheet(); });
  });

  if (store.needsPassphrase) {
    body.append(renderUnlock());
    return;
  }

  if (activeTab === 'platforms') body.append(renderPlatforms());
  else if (activeTab === 'taste') body.append(renderTaste());
  else if (activeTab === 'llm') body.append(renderLlm());
  else body.append(renderPrivacy());
}

/* ── 口令解锁 ── */
function renderUnlock() {
  const input = passwordInput({ placeholder: '输入访问口令' });
  const btn = el('button', { class: 'btn btn--primary btn--block', type: 'button' }, ['解锁']);
  const err = el('div', { class: 'field__hint' });
  const doUnlock = async () => {
    const pass = input.querySelector('input').value;
    if (!pass) return;
    err.textContent = '正在校验…';
    const ok = await store.unlockWithPassphrase(pass);
    if (ok) { toast('已解锁'); renderSheet(); }
    else err.textContent = '口令不正确';
  };
  btn.addEventListener('click', doUnlock);
  input.querySelector('input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); });

  return el('div', { class: 'pane is-on' }, [
    el('h3', { class: 'section-title', text: '需要口令' }),
    note('你为凭据开启了口令保护。输入口令后即可查看与修改已保存的账户信息。口令只存在于本次会话内存中，不会写入磁盘。', 'warn', 'lock'),
    field({ label: '访问口令', iconName: 'key', control: input }),
    err,
    btn,
    el('button', {
      class: 'btn btn--block', type: 'button',
      onclick: () => {
        store.vault.destroy();
        store.needsPassphrase = false;
        toast('已清除本地凭据');
        renderSheet();
      },
    }, ['忘记口令？清除本地已存凭据']),
  ]);
}

/* ── 平台 ── */
function renderPlatforms() {
  const pane = el('div', { class: 'pane is-on' });
  const s = store.settings;

  pane.append(note('勾选你常用的平台。实时采集用的是你自己浏览器里的登录态，'
    + '所以这里<b>不需要填密码</b>；账号只是给你自己看的备注。'));

  for (const p of PLATFORMS) {
    const conf = s.platforms[p.id];
    const cred = store.getCredential(p.id) || {};
    const enabledSwitch = switchEl(conf.enabled, (on) => {
      store.saveSettings({ platforms: { [p.id]: { enabled: on } } });
      refreshHome();
    }, `${p.name} 开关`);

    const body = [];
    for (const f of p.loginFields) {
      const ctrl = f.secret
        ? passwordInput({
          value: cred[f.key] || '',
          placeholder: f.placeholder,
          onInput: (v) => { saveCred(p.id, { ...(store.getCredential(p.id) || {}), [f.key]: v }); },
        })
        : textInput({
          value: cred[f.key] || '',
          placeholder: f.placeholder,
          onInput: (v) => { saveCred(p.id, { ...(store.getCredential(p.id) || {}), [f.key]: v }); },
        });
      body.push(field({ label: f.label, iconName: f.secret ? 'lock' : 'store', control: ctrl }));
    }

    // 平台会员选项
    const optRows = (p.options || []).map((opt) => checkRow({
      checked: !!conf.options?.[opt],
      title: opt,
      desc: '有会员时会把会员价与专属券计入比价',
      onChange: (on) => {
        store.saveSettings({ platforms: { [p.id]: { options: { [opt]: on } } } });
      },
    }));
    if (optRows.length) {
      body.push(el('div', { class: 'field__label', text: '会员状态' }));
      body.push(...optRows);
    }

    body.push(el('div', { class: 'field__hint' }, [
      el('span', { text: `${p.blurb} · ${p.shippingHint}` }),
    ]));

    if (store.hasCredential(p.id)) {
      body.push(el('button', {
        class: 'btn btn--danger btn--block',
        type: 'button',
        onclick: async () => {
          await store.setCredential(p.id, null);
          toast(`已删除 ${p.name} 的本地账户信息`);
          renderSheet();
        },
      }, [icon('trash'), '删除该平台的本地账户信息']));
    }

    pane.append(collapsible({
      open: conf.enabled && !store.hasCredential(p.id),
      head: [
        el('span', { class: 'group__logo', style: { '--p-color': p.color, '--p-tint': p.tint }, text: p.short }),
        el('span', { class: 'group__meta' }, [
          el('span', { class: 'group__name' }, [
            p.name,
            store.hasCredential(p.id) ? el('span', { class: 'plat-tag', style: { '--p-color': p.color, '--p-tint': p.tint, '--p-line': p.line } }, [
              el('span', { class: 'plat-tag__dot' }), '已登记',
            ]) : null,
          ]),
          el('span', { class: 'group__desc', text: p.blurb }),
        ]),
        enabledSwitch,
      ],
      body,
    }));
  }

  // 数据来源
  const cfg = store.settings.dataSource;
  const modeSel = el('select', { class: 'select' });
  for (const src of SOURCES) {
    modeSel.append(el('option', { value: src.id, selected: cfg.mode === src.id, text: src.label }));
  }
  modeSel.append(el('option', { value: 'auto', selected: cfg.mode === 'auto', text: '自动（配了接口用接口，否则实时采集）' }));
  modeSel.append(el('option', { value: 'none', selected: cfg.mode === 'none', text: '不使用任何数据源' }));
  modeSel.value = cfg.mode;
  modeSel.addEventListener('change', () => {
    store.saveSettings({ dataSource: { mode: modeSel.value } });
    renderSheet();
  });

  const endpointInput = textInput({
    value: cfg.endpoint,
    placeholder: 'https://your-backend.example.com/meal/search',
    onInput: (v) => store.saveSettings({ dataSource: { endpoint: v } }),
  });

  const portInput = textInput({
    value: String(cfg.relayPort || DEFAULT_RELAY_PORT),
    placeholder: '8765',
    onInput: (v) => {
      const n = Number(String(v).replace(/\D/g, ''));
      if (n >= 1024 && n <= 65535) store.saveSettings({ dataSource: { relayPort: n } });
    },
  });

  const tabsSel = el('select', { class: 'select' });
  tabsSel.append(el('option', { value: 'visible', selected: cfg.openTabs !== 'background', text: '打开可见标签页（推荐，能顺便确认登录状态）' }));
  tabsSel.append(el('option', { value: 'background', selected: cfg.openTabs === 'background', text: '尽量在后台打开（不打扰，但可能被浏览器节流）' }));
  tabsSel.addEventListener('change', () => store.saveSettings({ dataSource: { openTabs: tabsSel.value } }));

  // 采集器状态：实时探测中继
  const statusRow = el('div', { class: 'relay-status' }, [
    el('span', { class: 'relay-status__dot is-checking' }),
    el('span', { class: 'relay-status__text', text: '正在检测本地中继…' }),
  ]);
  const actions = el('div', { class: 'relay-actions' });
  probeRelay(store.settings).then((r) => {
    statusRow.replaceChildren();
    if (r.ok) {
      statusRow.append(
        el('span', { class: 'relay-status__dot is-ok' }),
        el('span', { class: 'relay-status__text' }, [
          el('b', { text: '中继已连接' }),
          el('span', { text: `　${r.base}` }),
        ]),
      );
      const seen = r.collectorSeen;
      statusRow.append(el('span', {
        class: 'relay-status__text',
        text: seen == null
          ? '　采集器还没出现过——请确认已安装脚本，并打开过一次平台页面'
          : `　采集器最近活跃：${Math.max(1, Math.round(seen / 1000))} 秒前`,
      }));
      actions.append(el('a', {
        class: 'btn btn--block', href: `${r.base}/install`, target: '_blank', rel: 'noopener',
      }, [icon('download'), '打开采集器安装页']));
    } else {
      statusRow.append(
        el('span', { class: 'relay-status__dot is-off' }),
        el('span', { class: 'relay-status__text' }, [
          el('b', { text: '中继没在运行' }),
          el('span', { text: `　${r.error}${r.mixedContent ? '（当前页面是 https，浏览器会拦截本地中继，请改用中继托管的页面）' : ''}` }),
        ]),
      );
      actions.append(el('div', { class: 'field__hint' }, [
        el('span', { text: '在项目目录里执行：' }),
        el('code', { text: 'node relay/server.mjs' }),
        el('span', { text: '　（Windows 上双击 relay 目录里的启动脚本也行）' }),
      ]));
    }
  });

  pane.append(el('h3', { class: 'section-title', text: '价格数据从哪来' }));
  pane.append(collapsible({
    open: cfg.mode !== 'realtime',
    head: [
      el('span', { class: 'group__logo', style: { '--p-color': '#5AA9E6', '--p-tint': 'rgba(90,169,230,.12)' } }, [icon('plug')]),
      el('span', { class: 'group__meta' }, [
        el('span', { class: 'group__name', text: '数据来源' }),
        el('span', {
          class: 'group__desc',
          text: cfg.mode === 'custom' ? '自备数据接口'
            : cfg.mode === 'none' ? '已关闭'
              : cfg.endpoint ? '自动：优先用自备接口' : '实时采集',
        }),
      ]),
    ],
    body: [
      note('价格只有两个来源：<b>实时采集</b>（在你自己的浏览器里读各平台真实返回的价格）'
        + '或<b>你自备的数据接口</b>。工具里不存在任何模拟或占位价格。', 'info', 'info'),
      field({ label: '数据模式', iconName: 'plug', control: modeSel }),

      el('div', { class: 'field__label', text: '实时采集' }),
      statusRow,
      actions,
      field({ label: '中继端口', iconName: 'sliders', control: portInput, hint: '改了端口要同步改中继启动参数：node relay/server.mjs --port 端口' }),
      field({ label: '采集时如何打开平台页面', iconName: 'external', control: tabsSel }),

      el('div', { class: 'field__label', text: '自备接口（可选）' }),
      field({
        label: '接口地址',
        iconName: 'external',
        control: endpointInput,
        hint: '前端会向该地址 POST 一个 JSON（含 keywords / platform / budget 等），期望返回候选数组。字段约定见 README。',
      }),
    ],
  }));

  return pane;
}

let credTimer = null;
function saveCred(platformId, values) {
  clearTimeout(credTimer);
  credTimer = setTimeout(async () => {
    try {
      await store.setCredential(platformId, values);
      refreshHome();
    } catch {
      toast('凭据保存失败：保险箱处于锁定状态', { icon: 'lock' });
    }
  }, 500);
}

/* ── 口味 ── */
function renderTaste() {
  const pane = el('div', { class: 'pane is-on' });
  const s = store.settings;

  pane.append(note('勾选长期偏好，每次筛选都会带上；预算开启后会作为硬上限参与比价。'));

  pane.append(el('h3', { class: 'section-title', text: '长期口味' }));
  const tasteWrap = el('div', { class: 'card__deals' });
  for (const t of TASTES) {
    const on = s.tastes.includes(t.id);
    const chip = el('button', {
      class: 'chip',
      type: 'button',
      style: on ? {
        color: 'var(--accent-deep)',
        borderColor: 'rgba(255,138,61,.45)',
        background: 'rgba(255,138,61,.10)',
      } : {},
    }, [t.label]);
    chip.title = t.desc;
    chip.addEventListener('click', () => {
      const list = new Set(store.settings.tastes);
      if (list.has(t.id)) list.delete(t.id); else list.add(t.id);
      store.saveSettings({ tastes: Array.from(list) });
      renderSheet();
    });
    tasteWrap.append(chip);
  }
  pane.append(tasteWrap);

  pane.append(el('h3', { class: 'section-title', text: '预算' }));
  const budgetOn = checkRow({
    checked: s.budget.enabled,
    title: '设置单次预算上限',
    desc: '超过上限的套餐直接排除',
    onChange: (on) => { store.saveSettings({ budget: { enabled: on } }); renderSheet(); },
  });
  pane.append(budgetOn);
  if (s.budget.enabled) {
    pane.append(slider({
      name: '预算上限',
      min: 10, max: 200, step: 5, value: s.budget.max,
      onInput: (v) => store.saveSettings({ budget: { max: v } }),
    }));
    pane.append(el('div', { class: 'field__hint', text: `当前上限：${money(s.budget.max)}（含配送与打包费）` }));
  }

  pane.append(el('h3', { class: 'section-title', text: '加权偏好' }));
  pane.append(note('拖到你觉得重要的位置就行，权重会自动归一化，不用手动凑够 100%。'));

  const weightBox = el('div', { class: 'group is-open' }, [
    el('div', { class: 'group__head' }, [
      el('span', { class: 'group__logo', style: { '--p-color': '#FF8A3D', '--p-tint': 'rgba(255,138,61,.12)' } }, [icon('wallet')]),
      el('span', { class: 'group__meta' }, [
        el('span', { class: 'group__name', text: '各因子权重' }),
        el('span', { class: 'group__desc', text: '数值越大，该因子对排名影响越大' }),
      ]),
    ]),
    el('div', { class: 'group__body' }, [
      el('div', { class: 'group__inner' }, [
        el('div', { class: 'group__inner-pad' },
          FACTORS.map((f) => slider({
            name: f.label,
            min: 0, max: 40, step: 1,
            value: clamp(store.settings.weights[f.id] ?? f.weight, 0, 40),
            onInput: (v) => store.saveSettings({ weights: { [f.id]: v } }),
          }))),
      ]),
    ]),
  ]);
  pane.append(weightBox);

  pane.append(el('button', {
    class: 'btn btn--block',
    type: 'button',
    onclick: () => {
      store.saveSettings({ weights: { ...DEFAULT_WEIGHTS } });
      toast('权重已恢复默认');
      renderSheet();
    },
  }, [icon('undo'), '恢复默认权重']));

  return pane;
}

/* ── 智能转写 ── */
function renderLlm() {
  const pane = el('div', { class: 'pane is-on' });
  const s = store.settings;
  const cfg = s.llm;

  const headSwitch = switchEl(cfg.enabled, (on) => {
    store.saveSettings({ llm: { enabled: on } });
    renderSheet();
  }, 'LLM 转写开关');

  pane.append(el('div', { class: 'group__head', style: { padding: '0 0 var(--s-3)' } }, [
    el('span', { class: 'group__logo', style: { '--p-color': '#9B6BB5', '--p-tint': 'rgba(155,107,181,.12)' } }, [icon('sparkle')]),
    el('span', { class: 'group__meta' }, [
      el('span', { class: 'group__name', text: '用大模型理解你的话' }),
      el('span', { class: 'group__desc', text: '只做关键词转写，不参与挑店与定价' }),
    ]),
    headSwitch,
  ]));

  pane.append(note('开启后，你说的那句模糊描述会先交给模型转成搜索关键词；'
    + '模型<b>不会</b>给出最终推荐，挑店、算价、排名全部在本机完成。'
    + '不开启时使用内置的轻量转写，零成本、离线可用。'));

  const today = store.todayUsage();
  const total = store.usage.totalCost || 0;

  const apiKeyCtrl = passwordInput({
    value: store.getApiKey(),
    placeholder: 'sk-...',
    onInput: (v) => { store.setApiKey(v).catch(() => toast('API Key 保存失败', { icon: 'lock' })); },
  });

  const baseUrlInput = textInput({
    value: cfg.baseUrl,
    placeholder: 'https://api.deepseek.com/v1',
    onInput: (v) => store.saveSettings({ llm: { baseUrl: v } }),
  });
  const modelInput = textInput({
    value: cfg.model,
    placeholder: 'deepseek-chat',
    onInput: (v) => store.saveSettings({ llm: { model: v } }),
  });
  const priceInInput = textInput({
    value: String(cfg.priceIn),
    placeholder: '1',
    onInput: (v) => store.saveSettings({ llm: { priceIn: Number(v) || 0 } }),
  });
  const priceOutInput = textInput({
    value: String(cfg.priceOut),
    placeholder: '2',
    onInput: (v) => store.saveSettings({ llm: { priceOut: Number(v) || 0 } }),
  });

  const testBtn = el('button', { class: 'btn btn--block', type: 'button' }, [icon('plug'), '测试连接']);
  const testOut = el('div', { class: 'field__hint' });
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testOut.textContent = '正在请求…';
    const r = await llmPing({ apiKey: store.getApiKey(), cfg: store.settings.llm });
    if (r.ok) {
      const cost = r.cost || 0;
      testOut.textContent = `连接正常，返回关键词：${(r.parsed?.keywords || []).join(' / ') || '（空）'}`
        + `　本次约 ${costText(cost)}`;
      toast('连接正常', { icon: 'check' });
    } else {
      testOut.textContent = `失败：${r.error}`;
      toast('连接失败', { icon: 'info' });
    }
    testBtn.disabled = false;
  });

  pane.append(field({ label: 'API Key', iconName: 'key', control: apiKeyCtrl, hint: '加密保存在本机，不会随导出数据一起带走（除非你主动勾选）。' }));
  pane.append(field({ label: '接口地址（OpenAI 兼容）', iconName: 'external', control: baseUrlInput, hint: '填到 /v1 为止，会自动补 /chat/completions。' }));
  pane.append(field({ label: '模型名', iconName: 'sparkle', control: modelInput }));

  pane.append(el('div', { class: 'row' }, [
    field({ label: '输入价（元/百万 token）', control: priceInInput }),
    field({ label: '输出价（元/百万 token）', control: priceOutInput }),
  ]));
  pane.append(el('div', { class: 'field__hint', text: '按你所用服务商的价目表填写，用于估算花费。填 0 则不显示金额。' }));

  pane.append(el('h3', { class: 'section-title', text: '用量' }));
  pane.append(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: String(today.calls) }),
      el('div', { class: 'stat__k', text: '今日调用次数' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: costText(today.cost) }),
      el('div', { class: 'stat__k', text: '今日花费（估算）' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: `${(today.tokensIn + today.tokensOut).toLocaleString()}` }),
      el('div', { class: 'stat__k', text: '今日 token' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: costText(total) }),
      el('div', { class: 'stat__k', text: '累计花费（估算）' }),
    ]),
  ]));
  pane.append(el('div', { class: 'row' }, [
    testBtn,
    el('button', {
      class: 'btn', type: 'button',
      onclick: () => { store.clearUsage(); toast('用量已清零'); renderSheet(); },
    }, ['清零统计']),
  ]));
  pane.append(testOut);

  return pane;
}

/* ── 隐私 ── */
function renderPrivacy() {
  const pane = el('div', { class: 'pane is-on' });
  const bytes = store.storageBytes();
  const credCount = store.countSavedCredentials();

  pane.append(el('h3', { class: 'section-title', text: '本机数据' }));
  pane.append(el('div', { class: 'stat-grid' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: String(credCount) }),
      el('div', { class: 'stat__k', text: '已登记的平台账户' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB` }),
      el('div', { class: 'stat__k', text: '本地占用' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: store.hasApiKey() ? '已保存' : '未设置' }),
      el('div', { class: 'stat__k', text: 'API Key' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'stat__v', text: store.vault.hasPassphraseSet() ? '已开启' : '未开启' }),
      el('div', { class: 'stat__k', text: '口令保护' }),
    ]),
  ]));

  pane.append(note(
    CRYPTO_MODE === 'aes-gcm'
      ? '密钥与账号备注使用 <b>AES-GCM 256</b> 加密后写入本机存储，默认由设备密钥自动解锁，所以你不必每次重填。'
      : '当前浏览器环境未提供加密能力（例如以 file:// 打开且浏览器限制了 WebCrypto），'
        + '这些内容只做了<b>混淆存储</b>，并非真正加密。建议改用 http(s) 方式打开本页，别在这里填敏感信息。',
    CRYPTO_MODE === 'aes-gcm' ? 'good' : 'warn',
    CRYPTO_MODE === 'aes-gcm' ? 'shield' : 'info'
  ));

  pane.append(note('实时比价用的是你浏览器里已有的登录态，所以这里<b>不需要、也不该填</b>平台密码；'
    + '账号一栏只是给你自己看的备注。真正敏感的是大模型 API Key —— '
    + '纯前端工具无法防御同机恶意脚本，建议为它单独开启口令保护。', 'warn', 'info'));

  /* 口令 */
  const passInput = passwordInput({ placeholder: '新口令（至少 6 位）' });
  const curInput = passwordInput({ placeholder: '当前口令（取消时需要）' });
  const passOut = el('div', { class: 'field__hint' });

  const setBtn = el('button', { class: 'btn btn--primary btn--block', type: 'button' }, [
    icon('lock'), store.vault.hasPassphraseSet() ? '更换口令' : '开启口令保护',
  ]);
  setBtn.addEventListener('click', async () => {
    const next = passInput.querySelector('input').value;
    const cur = store.vault.hasPassphraseSet() ? curInput.querySelector('input').value : null;
    if (!next) { passOut.textContent = '请输入新口令'; return; }
    passOut.textContent = '正在加密写入…';
    const r = await store.setPassphrase(next, cur);
    passOut.textContent = r.ok ? '已更新。下次打开需要输入口令。' : `失败：${r.error}`;
    if (r.ok) { toast('口令已更新', { icon: 'lock' }); renderSheet(); }
  });

  const clearPassBtn = el('button', { class: 'btn btn--block', type: 'button' }, [
    icon('key'), '取消口令保护（改回自动解锁）',
  ]);
  clearPassBtn.addEventListener('click', async () => {
    const cur = curInput.querySelector('input').value;
    const r = await store.setPassphrase(null, cur);
    passOut.textContent = r.ok ? '已取消口令，恢复自动解锁。' : `失败：${r.error}`;
    if (r.ok) { toast('已取消口令保护'); renderSheet(); }
  });

  pane.append(el('h3', { class: 'section-title', text: '口令保护' }));
  pane.append(field({ label: '新口令', iconName: 'lock', control: passInput }));
  if (store.vault.hasPassphraseSet()) {
    pane.append(field({ label: '当前口令', iconName: 'key', control: curInput }));
  }
  pane.append(setBtn);
  if (store.vault.hasPassphraseSet()) pane.append(clearPassBtn);
  pane.append(passOut);

  /* 导出导入 */
  const exportBtn = el('button', { class: 'btn btn--block', type: 'button' }, [icon('copy'), '导出设置（不含账户与密钥）']);
  exportBtn.addEventListener('click', () => downloadText(
    `meal-picker-settings-${Date.now()}.json`,
    store.exportData({ includeSecrets: false })
  ));

  const importInput = el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    const text = await f.text();
    const r = await store.importData(text);
    toast(r.ok ? '已导入设置' : `导入失败：${r.error}`, { icon: r.ok ? 'check' : 'info' });
    if (r.ok) renderSheet();
    importInput.value = '';
  });
  const importBtn = el('button', { class: 'btn btn--block', type: 'button' }, [icon('external'), '导入设置文件']);
  importBtn.addEventListener('click', () => importInput.click());

  pane.append(el('h3', { class: 'section-title', text: '迁移与备份' }));
  pane.append(exportBtn, importBtn, importInput);

  /* 清除 */
  pane.append(el('h3', { class: 'section-title', text: '清除' }));
  let armed = false;
  const wipeBtn = el('button', { class: 'btn btn--danger btn--block', type: 'button' }, [icon('trash'), '清除全部本地数据']);
  wipeBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      wipeBtn.replaceChildren(icon('trash'), document.createTextNode('再点一次确认清除'));
      setTimeout(() => {
        armed = false;
        wipeBtn.replaceChildren(icon('trash'), document.createTextNode('清除全部本地数据'));
      }, 4000);
      return;
    }
    store.wipeAll();
    toast('本地数据已全部清除', { icon: 'check' });
    refreshHome();
    renderSheet();
  });
  pane.append(wipeBtn);
  pane.append(el('div', { class: 'field__hint', text: '包括平台账户、API Key、口味偏好与用量统计，全部从本机移除。' }));

  return pane;
}

/* ══════════════ 小工具 ══════════════ */

export function costText(cost) {
  const v = Number(cost) || 0;
  if (v <= 0) return '¥0';
  if (v < 0.001) return '<¥0.001';
  if (v < 0.01) return `¥${v.toFixed(4)}`;
  if (v < 1) return `¥${v.toFixed(3)}`;
  return `¥${v.toFixed(2)}`;
}

function downloadText(filename, text) {
  try {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('已导出');
  } catch {
    toast('导出失败', { icon: 'info' });
  }
}
