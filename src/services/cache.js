/**
 * Persistencia local:
 *  - Credenciales cifradas (AES-GCM, clave no extraíble guardada en IndexedDB)
 *    y el texto cifrado en localStorage. Sin WebCrypto (http no seguro) se ofuscan.
 *  - Catálogos (categorías y streams) en IndexedDB con TTL y
 *    stale-while-error: si el panel cae, se sirve la última copia.
 *  - Ajustes en localStorage.
 */
import { createStore, get, set, del, keys, delMany } from 'idb-keyval';

const catalogStore = createStore('gamapro-cache', 'kv');
const keyStore = createStore('gamapro-keys', 'kv');

const CRED_KEY = 'gp.cred';
const SETTINGS_KEY = 'gp.settings';
const HOUR = 3600_000;

export const DEFAULT_SETTINGS = Object.freeze({
  proxyUrl: '',
  proxyMode: 'auto', // off | auto | always
  liveFormat: 'm3u8', // m3u8 | ts
  cacheHours: 12,
});

// ---------- Ajustes ----------
export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* modo privado */ }
  return next;
}

// ---------- Credenciales ----------
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
const OBF_SALT = 'gamapro::v1';

async function deviceKey() {
  if (!globalThis.crypto?.subtle) return null;
  let key = await get('aes', keyStore).catch(() => null);
  if (!key) {
    key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await set('aes', key, keyStore);
  }
  return key;
}

function xor(bytes) {
  const salt = new TextEncoder().encode(OBF_SALT);
  return bytes.map((b, i) => b ^ salt[i % salt.length]);
}

export async function saveCredentials(creds) {
  const plain = new TextEncoder().encode(JSON.stringify(creds));
  let payload;
  try {
    const key = await deviceKey();
    if (!key) throw new Error('sin WebCrypto');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    payload = `v1:${b64(out)}`;
  } catch {
    payload = `x1:${b64(xor(plain))}`;
  }
  localStorage.setItem(CRED_KEY, payload);
}

export async function loadCredentials() {
  const payload = localStorage.getItem(CRED_KEY);
  if (!payload) return null;
  try {
    const [ver, data] = payload.split(':');
    const bytes = unb64(data);
    let plain;
    if (ver === 'v1') {
      const key = await deviceKey();
      plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
    } else {
      plain = xor(bytes);
    }
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    localStorage.removeItem(CRED_KEY);
    return null;
  }
}

export function clearCredentials() {
  localStorage.removeItem(CRED_KEY);
}

// ---------- Catálogo ----------
/** Prefijo por cuenta para que dos cuentas no compartan caché. */
export function accountKey({ host, username }) {
  let h = 0x811c9dc5;
  for (const c of `${host}|${username}`) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return (h >>> 0).toString(36);
}

const memory = new Map();

/**
 * Devuelve datos cacheados o ejecuta loader(). Orden: memoria → IndexedDB → red.
 * Si la red falla y existe una copia vieja, la devuelve (marcada como stale).
 */
export async function cached(key, loader, { ttlHours = loadSettings().cacheHours, force = false } = {}) {
  const ttl = ttlHours * HOUR;
  let record = memory.get(key);
  if (!record) {
    record = await get(key, catalogStore).catch(() => undefined);
    if (record) memory.set(key, record);
  }
  if (!force && record && Date.now() - record.t < ttl) return record.data;

  try {
    const data = await loader();
    const fresh = { t: Date.now(), data };
    memory.set(key, fresh);
    set(key, fresh, catalogStore).catch((e) => console.warn('[cache] no se pudo guardar', key, e));
    return data;
  } catch (err) {
    if (record) {
      console.warn('[cache] usando copia antigua de', key, err);
      return record.data;
    }
    throw err;
  }
}

export async function cacheAge(key) {
  const record = memory.get(key) || (await get(key, catalogStore).catch(() => undefined));
  return record ? Date.now() - record.t : Infinity;
}

export async function clearCatalogCache(prefix = '') {
  for (const k of [...memory.keys()]) if (String(k).startsWith(prefix)) memory.delete(k);
  const all = await keys(catalogStore);
  await delMany(all.filter((k) => String(k).startsWith(prefix)), catalogStore);
}

export function forget(key) {
  memory.delete(key);
  return del(key, catalogStore);
}
