/**
 * 持久化层
 *  - 设置 / 历史 / 用量：普通 localStorage（不含敏感信息）
 *  - 账户与 API Key：走 Vault 加密存储
 *  - 全程带版本号，方便日后迁移
 */

import { DEFAULT_SETTINGS, PLATFORMS, DEFAULT_WEIGHTS } from './catalog.js';
import { Vault, CRYPTO_MODE, deviceFingerprint } from './crypto.js';
import { dayKey } from './util.js';

const K_SETTINGS = 'mealpicker.settings.v1';
const K_HISTORY = 'mealpicker.history.v1';
const K_USAGE = 'mealpicker.usage.v1';
const K_VAULT = 'mealpicker.vault.v1';

const MAX_HISTORY = 30;

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const val = JSON.parse(raw);
    return val ?? fallback;
  } catch { return fallback; }
}
function writeJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch { return false; }
}

/** 深合并（对象递归，数组整体替换） */
function merge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch ?? base;
  if (typeof base !== 'object' || base === null || typeof patch !== 'object' || patch === null) {
    return patch === undefined ? base : patch;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = merge(base[k], v);
  return out;
}

export class Store {
  constructor() {
    this.settings = this._loadSettings();
    this.history = readJSON(K_HISTORY, []);
    this.usage = readJSON(K_USAGE, { days: {}, totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 });
    this.vault = new Vault(K_VAULT);
    this.cryptoMode = CRYPTO_MODE;
    this.deviceId = deviceFingerprint();
    this.vaultReady = false;
    this.needsPassphrase = false;
    this._listeners = new Set();
  }

  /* ───── 生命周期 ───── */

  async init() {
    const ok = await this.vault.unlockDevice();
    this.vaultReady = true;
    this.needsPassphrase = !ok && this.vault.hasPassphraseSet();
    return { vaultReady: true, needsPassphrase: this.needsPassphrase };
  }

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { for (const fn of this._listeners) { try { fn(this); } catch { /* ignore */ } } }

  _loadSettings() {
    const raw = readJSON(K_SETTINGS, null);
    const s = merge(structuredClone(DEFAULT_SETTINGS), raw || {});
    // 平台键补齐（升级后新增平台时）
    for (const p of PLATFORMS) {
      if (!s.platforms[p.id]) s.platforms[p.id] = { enabled: false, options: {} };
      if (!s.platforms[p.id].options) s.platforms[p.id].options = {};
    }
    if (!s.weights || !Object.keys(s.weights).length) s.weights = { ...DEFAULT_WEIGHTS };
    return s;
  }

  saveSettings(patch) {
    this.settings = merge(this.settings, patch || {});
    writeJSON(K_SETTINGS, this.settings);
    this._emit();
    return this.settings;
  }

  resetSettings() {
    this.settings = structuredClone(DEFAULT_SETTINGS);
    writeJSON(K_SETTINGS, this.settings);
    this._emit();
    return this.settings;
  }

  /* ───── 凭据 ───── */

  get credentials() {
    if (!this.vaultReady || this.vault.locked) return {};
    return this.vault.data().credentials || {};
  }

  getCredential(platformId) {
    return this.credentials[platformId] || null;
  }

  async setCredential(platformId, values) {
    if (!this.vaultReady) await this.init();
    if (this.vault.locked) throw new Error('locked');
    const data = this.vault.data();
    data.credentials = data.credentials || {};
    if (values === null) delete data.credentials[platformId];
    else data.credentials[platformId] = { ...values, savedAt: Date.now() };
    await this.vault.save();
    this._emit();
  }

  /** 是否存在某平台的已保存凭据 */
  hasCredential(platformId) {
    const c = this.credentials[platformId];
    return !!(c && (c.account || c.token));
  }

  /** LLM 配置里的 API Key 单独放保险箱 */
  getApiKey() {
    if (!this.vaultReady || this.vault.locked) return '';
    return this.vault.data().apiKey || '';
  }
  async setApiKey(key) {
    if (!this.vaultReady) await this.init();
    if (this.vault.locked) throw new Error('locked');
    const data = this.vault.data();
    if (key) data.apiKey = key; else delete data.apiKey;
    await this.vault.save();
    this._emit();
  }
  hasApiKey() { return !!this.getApiKey(); }

  async unlockWithPassphrase(pass) {
    const ok = await this.vault.unlockPassphrase(pass);
    if (ok) { this.needsPassphrase = false; this._emit(); }
    return ok;
  }
  lockVault() { this.vault.lock(); this._emit(); }
  async setPassphrase(next, current) {
    const r = await this.vault.setPassphrase(next, current);
    if (r.ok) this._emit();
    return r;
  }

  /* ───── 历史 ───── */

  pushHistory(entry) {
    this.history = [entry, ...this.history.filter((h) => h.q !== entry.q)].slice(0, MAX_HISTORY);
    writeJSON(K_HISTORY, this.history);
  }
  clearHistory() { this.history = []; writeJSON(K_HISTORY, []); }

  /* ───── LLM 用量 / 费用 ───── */

  recordUsage({ tokensIn = 0, tokensOut = 0, cost = 0, model = '', mode = '' } = {}) {
    const k = dayKey();
    const days = this.usage.days || {};
    const d = days[k] || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    d.calls += 1;
    d.tokensIn += tokensIn;
    d.tokensOut += tokensOut;
    d.cost += cost;
    days[k] = d;
    this.usage.days = days;
    this.usage.totalCalls = (this.usage.totalCalls || 0) + 1;
    this.usage.totalTokensIn = (this.usage.totalTokensIn || 0) + tokensIn;
    this.usage.totalTokensOut = (this.usage.totalTokensOut || 0) + tokensOut;
    this.usage.totalCost = (this.usage.totalCost || 0) + cost;
    this.usage.last = { at: Date.now(), model, mode, tokensIn, tokensOut, cost };
    writeJSON(K_USAGE, this.usage);
    this._emit();
  }
  todayUsage() {
    return (this.usage.days || {})[dayKey()] || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
  }
  clearUsage() {
    this.usage = { days: {}, totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 };
    writeJSON(K_USAGE, this.usage);
    this._emit();
  }

  /* ───── 数据主权：导出 / 导入 / 彻底清除 ───── */

  /**
   * 导出。默认**不含**凭据；includeSecrets 为真时导出口令模式下的明文（需要已解锁）。
   */
  exportData({ includeSecrets = false } = {}) {
    const payload = {
      app: 'meal-picker',
      exportedAt: new Date().toISOString(),
      settings: this.settings,
      history: this.history,
      usage: this.usage,
    };
    if (includeSecrets) payload.credentials = this.credentials;
    return JSON.stringify(payload, null, 2);
  }

  async importData(text) {
    let obj;
    try { obj = JSON.parse(text); } catch { return { ok: false, error: '不是合法的 JSON' }; }
    if (!obj || obj.app !== 'meal-picker') return { ok: false, error: '不是本工具导出的文件' };
    if (obj.settings) this.saveSettings(obj.settings);
    if (Array.isArray(obj.history)) { this.history = obj.history.slice(0, MAX_HISTORY); writeJSON(K_HISTORY, this.history); }
    if (obj.usage) { this.usage = merge(this.usage, obj.usage); writeJSON(K_USAGE, this.usage); }
    if (obj.credentials && !this.vault.locked) {
      const data = this.vault.data();
      data.credentials = { ...(data.credentials || {}), ...obj.credentials };
      await this.vault.save();
    }
    this._emit();
    return { ok: true };
  }

  /** 彻底清除：设置、历史、用量、凭据、设备密钥 */
  wipeAll() {
    try { localStorage.removeItem(K_SETTINGS); } catch { /* ignore */ }
    try { localStorage.removeItem(K_HISTORY); } catch { /* ignore */ }
    try { localStorage.removeItem(K_USAGE); } catch { /* ignore */ }
    this.vault.destroy();
    this.settings = structuredClone(DEFAULT_SETTINGS);
    this.history = [];
    this.usage = { days: {}, totalCalls: 0, totalTokensIn: 0, totalTokensOut: 0, totalCost: 0 };
    this._emit();
  }

  /** 存储占用（字节，粗略） */
  storageBytes() {
    let n = 0;
    for (const k of [K_SETTINGS, K_HISTORY, K_USAGE, K_VAULT]) {
      try { n += (localStorage.getItem(k) || '').length; } catch { /* ignore */ }
    }
    return n * 2; // UTF-16
  }

  countSavedCredentials() {
    return Object.keys(this.credentials).length;
  }
}

export const store = new Store();
