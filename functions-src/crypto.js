// Page lock: the dashboard is served encrypted and decrypted in the browser.
// key = PBKDF2-HMAC-SHA256(password, salt, iterations); cipher = AES-256-GCM, random 12-byte IV.
// WebCrypto only (no Node `crypto`, no Buffer), so server and browser run the same code.

export const b64 = bytes => {                         // chunked: String.fromCharCode(...big) overflows the stack
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export function safeEqual(a, b) {                     // constant-time compare, portable
  const ea = new TextEncoder().encode(String(a ?? '')), eb = new TextEncoder().encode(String(b ?? ''));
  const len = Math.max(ea.length, eb.length, 1);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < len; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

/** -> { v:1, iter, salt, iv, data } with base64 fields */
export async function encryptPage(html, password, salt, iter) {
  const key = await deriveKey(password, salt, iter);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(html)));
  return { v: 1, iter, salt: b64(salt), iv: b64(iv), data: b64(data) };
}
