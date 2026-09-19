/**
 * 凭据保险箱
 *
 * 设计目标：
 *  1. 绝不明文落盘。所有账户信息 / API Key 一律先加密再写入 localStorage。
 *  2. 用户不需要每次重新填写 —— 默认使用"设备密钥"自动解锁，打开即用。
 *  3. 高危信息（API Key、账户）额外支持"口令模式"：密钥不落盘，只有输入口令才能解密。
 *
 * 实现：
 *  - WebCrypto AES-GCM 256 加密；口令模式用 PBKDF2-SHA256 (310k 次) 派生密钥。
 *  - 非安全上下文（例如 file:// 且浏览器未开放 crypto.subtle）自动降级为
 *    流式异或 + Base64 的混淆存储，并在 UI 明确告知"仅混淆、非加密"。
 *
 * 边界（诚实说明）：纯前端无法抵御同机恶意脚本或拥有本机文件读取权限的攻击者。
 * 真正的敏感数据请用口令模式，或干脆不填。
 */

const subtle = (() => {
  try { return globalThis.crypto?.subtle ?? null; } catch { return null; }
})();

export const CRYPTO_MODE = subtle ? 'aes-gcm' : 'obfuscated';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ── base64 <-> bytes ── */
function b64(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  const CH = 0x8000;
  for (let i = 0; i < arr.length; i += CH) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + CH));
  }
  return btoa(s);
}
function unb64(str) {
  const raw = atob(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ── 设备密钥：随机生成并保存在 localStorage（自动解锁，用户零负担） ── */
const DEVICE_KEY_STORAGE = 'mealpicker.deviceKey.v1';

function deviceKeyBytes() {
  try {
    const saved = localStorage.getItem(DEVICE_KEY_STORAGE);
    if (saved) return unb64(saved);
  } catch { /* ignore */ }
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  try { localStorage.setItem(DEVICE_KEY_STORAGE, b64(bytes)); } catch { /* ignore */ }
  return bytes;
}

/* ── 降级：流式异或 + 校验和 ── */
function xorStream(data, key) {
  const out = new Uint8Array(data.length);
  let h = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    h ^= key[i % key.length] + i;
    h = Math.imul(h, 16777619) >>> 0;
    out[i] = data[i] ^ ((h >>> 11) & 0xff);
  }
  return out;
}
function fallbackSeal(obj, keyBytes) {
  const data = enc.encode(JSON.stringify(obj));
  const mixed = xorStream(data, keyBytes);
  const checksum = xorStream(enc.encode('mealpicker'), keyBytes).slice(0, 4);
  const all = new Uint8Array(mixed.length + 4);
  all.set(mixed, 0);
  all.set(checksum, mixed.length);
  return { v: 1, mode: 'obfuscated', data: b64(all) };
}
function fallbackOpen(blob, keyBytes) {
  const all = unb64(blob.data);
  const body = all.slice(0, all.length - 4);
  const checksum = all.slice(all.length - 4);
  const expect = xorStream(enc.encode('mealpicker'), keyBytes).slice(0, 4);
  for (let i = 0; i < 4; i++) if (checksum[i] !== expect[i]) throw new Error('bad key');
  return JSON.parse(dec.decode(xorStream(body, keyBytes)));
}

/* ── AES-GCM ── */
async function importRawKey(bytes) {
  return subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function aesSeal(obj, keyBytes, extra = {}) {
  const key = await importRawKey(keyBytes);
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, mode: 'aes-gcm', iv: b64(iv), data: b64(ct), ...extra };
}
async function aesOpen(blob, keyBytes) {
  const key = await importRawKey(keyBytes);
  const pt = await subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.data)
  );
  return JSON.parse(dec.decode(pt));
}

/* ── 口令派生 ── */
async function deriveFromPassphrase(passphrase, saltBytes, iterations = 310000) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
async function deriveRaw(passphrase, saltBytes, iterations = 310000) {
  const base = await subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base, 256
  );
  return new Uint8Array(bits);
}

/**
 * 保险箱：加密存一个任意对象
 */
export class Vault {
  /** @param {string} storageKey localStorage 键名 */
  constructor(storageKey) {
    this.storageKey = storageKey;
    this._cache = null;
    this._passphrase = null;   // 仅内存，永不落盘
    this._salt = null;
    this._iterations = 310000;
    this._locked = false;
  }

  get mode() { return CRYPTO_MODE; }
  get locked() { return this._locked; }
  get hasPassphrase() { return this._passphrase !== null; }

  _readBlob() {
    try {
      const raw = localStorage.getItem(this.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  _writeBlob(blob) {
    try { localStorage.setItem(this.storageKey, JSON.stringify(blob)); return true; }
    catch { return false; }
  }

  /** 是否存在已保存的密文 */
  exists() { return !!this._readBlob(); }

  /** 是否设置了口令 */
  hasPassphraseSet() {
    const blob = this._readBlob();
    return !!blob?.salt;
  }

  /** 设备密钥模式：自动解锁 */
  async unlockDevice() {
    if (CRYPTO_MODE !== 'aes-gcm') {
      this._locked = false;
      this._cache = this._cache ?? {};
      return true;
    }
    const blob = this._readBlob();
    if (!blob) { this._cache = {}; this._locked = false; return true; }
    if (blob.salt) { this._locked = true; return false; }   // 需要口令
    try {
      this._cache = await aesOpen(blob, deviceKeyBytes());
      this._locked = false;
      return true;
    } catch {
      this._cache = {};
      this._locked = false;
      return false;
    }
  }

  /** 口令模式解锁 */
  async unlockPassphrase(passphrase) {
    const blob = this._readBlob();
    if (!blob) return false;
    if (!blob.salt) return this.unlockDevice();
    if (CRYPTO_MODE !== 'aes-gcm') return false;
    try {
      const saltBytes = unb64(blob.salt);
      const raw = await deriveRaw(passphrase, saltBytes, blob.iterations || 310000);
      this._cache = await aesOpen(blob, raw);
      this._passphrase = passphrase;
      this._salt = saltBytes;
      this._iterations = blob.iterations || 310000;
      this._locked = false;
      return true;
    } catch {
      return false;
    }
  }

  /** 锁定（清掉内存里的明文与口令） */
  lock() {
    this._cache = null;
    this._passphrase = null;
    this._locked = this.exists();
  }

  data() {
    if (this._locked) throw new Error('vault-locked');
    return this._cache ?? {};
  }

  async save() {
    if (this._locked) throw new Error('vault-locked');
    const payload = this._cache ?? {};
    if (CRYPTO_MODE !== 'aes-gcm') {
      return this._writeBlob(fallbackSeal(payload, deviceKeyBytes()));
    }
    if (this._passphrase) {
      const raw = await deriveRaw(this._passphrase, this._salt, this._iterations);
      return this._writeBlob(await aesSeal(payload, raw, {
        salt: b64(this._salt), iterations: this._iterations, hint: 'passphrase'
      }));
    }
    return this._writeBlob(await aesSeal(payload, deviceKeyBytes(), { hint: 'device' }));
  }

  /**
   * 设置 / 更换 / 取消口令。返回 { ok, error }
   * 取消口令时需要提供当前口令。
   */
  async setPassphrase(next, current = null) {
    if (CRYPTO_MODE !== 'aes-gcm') {
      return { ok: false, error: '当前环境不支持加密，口令模式不可用' };
    }
    if (current !== null && this._passphrase !== current) {
      return { ok: false, error: '当前口令不正确' };
    }
    if (next) {
      if (next.length < 6) return { ok: false, error: '口令至少 6 位' };
      const salt = new Uint8Array(16);
      globalThis.crypto.getRandomValues(salt);
      this._passphrase = next;
      this._salt = salt;
      this._iterations = 310000;
    } else {
      this._passphrase = null;
      this._salt = null;
    }
    const ok = await this.save();
    return ok ? { ok: true } : { ok: false, error: '写入失败（浏览器存储可能已满或被禁用）' };
  }

  /** 彻底清除（含设备密钥） */
  destroy() {
    try { localStorage.removeItem(this.storageKey); } catch { /* ignore */ }
    try { localStorage.removeItem(DEVICE_KEY_STORAGE); } catch { /* ignore */ }
    this._cache = {};
    this._passphrase = null;
    this._salt = null;
    this._locked = false;
  }
}

/** 简单指纹，用于在 UI 上标识"这份数据是哪台设备写的" */
export function deviceFingerprint() {
  try {
    const b = deviceKeyBytes();
    let h = 0;
    for (let i = 0; i < 6; i++) h = (h * 31 + b[i]) >>> 0;
    return h.toString(16).padStart(8, '0').slice(0, 6);
  } catch { return '000000'; }
}
