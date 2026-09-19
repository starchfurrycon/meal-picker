/**
 * 通用 UI 原子：Toast、视图切换、Sheet 开关
 */

import { $, el, icon } from './util.js';

/* ══════════════ Toast ══════════════ */

const stack = () => $('#toasts');

export function toast(message, { icon: iconName = 'sparkle', duration = 2600 } = {}) {
  const host = stack();
  if (!host) return;
  const node = el('div', { class: 'toast' }, [icon(iconName), el('span', { text: message })]);
  host.append(node);
  setTimeout(() => {
    node.classList.add('is-out');
    setTimeout(() => node.remove(), 280);
  }, duration);
  // 最多同时 3 条
  while (host.children.length > 3) host.firstElementChild.remove();
}

/* ══════════════ 视图切换 ══════════════ */

const VIEWS = ['home', 'thinking', 'result'];
let currentView = 'home';

export function showView(name, { instant = false } = {}) {
  if (!VIEWS.includes(name)) return;
  const prev = currentView;
  const next = document.querySelector(`.view[data-view="${name}"]`);
  const old = document.querySelector(`.view[data-view="${prev}"]`);
  if (!next) return;

  document.body.dataset.view = name;

  if (instant || prev === name) {
    VIEWS.forEach((v) => {
      const node = document.querySelector(`.view[data-view="${v}"]`);
      if (!node) return;
      node.classList.toggle('is-on', v === name);
      node.classList.remove('is-out');
    });
    currentView = name;
    return;
  }

  if (old && old !== next) {
    old.classList.remove('is-on');
    old.classList.add('is-out');
    setTimeout(() => old.classList.remove('is-out'), 260);
  }
  next.classList.remove('is-out');
  next.classList.add('is-on');
  currentView = name;
}

export const getView = () => currentView;

/* ══════════════ Sheet ══════════════ */

let sheetOpen = false;
let onSheetClose = null;

export function openSheet(onClose) {
  const sheet = $('#sheet');
  if (!sheet || sheetOpen) return;
  onSheetClose = onClose || null;
  sheet.hidden = false;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => sheet.classList.add('is-open'));
  });
  sheetOpen = true;
  document.body.style.overflow = 'hidden';
}

export function closeSheet() {
  const sheet = $('#sheet');
  if (!sheet || !sheetOpen) return;
  sheet.classList.remove('is-open');
  sheetOpen = false;
  document.body.style.overflow = '';
  const cb = onSheetClose;
  onSheetClose = null;
  setTimeout(() => { if (!sheetOpen) sheet.hidden = true; if (cb) cb(); }, 420);
}

export const isSheetOpen = () => sheetOpen;

/* ══════════════ 表单原子 ══════════════ */

export function switchEl(checked, onChange, label) {
  const btn = el('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': checked ? 'true' : 'false',
    'aria-label': label || '开关',
  });
  btn.addEventListener('click', () => {
    const nextVal = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', nextVal ? 'true' : 'false');
    onChange(nextVal);
  });
  return btn;
}

export function field({ label, hint, iconName, control }) {
  return el('label', { class: 'field' }, [
    label ? el('span', { class: 'field__label' }, [iconName ? icon(iconName) : null, label]) : null,
    control,
    hint ? el('span', { class: 'field__hint', text: hint }) : null,
  ]);
}

export function textInput({ value = '', placeholder = '', type = 'text', onInput, id }) {
  const input = el('input', {
    class: 'input',
    type,
    value,
    placeholder,
    id,
    autocomplete: 'off',
    spellcheck: 'false',
  });
  if (onInput) input.addEventListener('input', () => onInput(input.value));
  return input;
}

export function passwordInput({ value = '', placeholder = '', onInput }) {
  const input = textInput({ value, placeholder, type: 'password', onInput });
  const wrap = el('div', { class: 'input-affix' }, [input]);
  const btn = el('button', {
    class: 'input-affix__btn',
    type: 'button',
    'aria-label': '显示/隐藏',
  }, [icon('eye')]);
  btn.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.replaceChildren(icon(showing ? 'eye' : 'eye-off'));
  });
  wrap.append(btn);
  return wrap;
}

export function note(text, kind = 'info', iconName = 'info') {
  return el('div', { class: `note${kind === 'info' ? '' : ' note--' + kind}` }, [
    icon(iconName),
    el('div', { html: text }),
  ]);
}

export function checkRow({ checked, title, desc, onChange }) {
  const row = el('div', { class: `check-row${checked ? ' is-on' : ''}`, role: 'checkbox', 'aria-checked': checked ? 'true' : 'false', tabindex: '0' }, [
    el('span', { class: 'check-row__box' }, [icon('check')]),
    el('span', { class: 'check-row__text' }, [
      el('span', { class: 'check-row__t', text: title }),
      desc ? el('span', { class: 'check-row__d', text: desc }) : null,
    ]),
  ]);
  const toggle = () => {
    const on = !row.classList.contains('is-on');
    row.classList.toggle('is-on', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
    onChange(on);
  };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  return row;
}

export function collapsible({ head, body, open = false }) {
  const group = el('div', { class: `group${open ? ' is-open' : ''}` });
  const headNode = el('div', { class: 'group__head', role: 'button', tabindex: '0' }, [
    ...head,
    el('span', { class: 'group__chev' }, [icon('chevron')]),
  ]);
  const inner = el('div', { class: 'group__inner' }, [el('div', { class: 'group__inner-pad' }, [].concat(body))]);
  const bodyNode = el('div', { class: 'group__body' }, [inner]);
  const toggle = () => group.classList.toggle('is-open');
  headNode.addEventListener('click', toggle);
  headNode.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
  });
  group.append(headNode, bodyNode);
  return group;
}

export function slider({ value, min = 0, max = 40, step = 1, name, onInput }) {
  const input = el('input', { type: 'range', min, max, step, value });
  const val = el('span', { class: 'slider-row__val', text: String(value) });
  input.addEventListener('input', () => {
    val.textContent = input.value;
    onInput(Number(input.value));
  });
  return el('div', { class: 'slider-row' }, [
    el('span', { class: 'slider-row__name', text: name }),
    input,
    val,
  ]);
}
