// src/lib/webCrypto.js
// Best-effort AES-GCM encryption for token storage in the browser.
// Native builds use expo-secure-store, which is backed by the OS Keychain
// (iOS) / Keystore (Android) — genuinely hardware-protected. The browser
// has no equivalent, so this encrypts before writing to localStorage as a
// defense against casual inspection of storage; anyone with full access to
// the browser profile could still recover the key, so this is a floor, not
// a guarantee, the way native secure storage is.
const KEY_STORAGE = "oms_web_key_v1";

async function getKey() {
  const stored = localStorage.getItem(KEY_STORAGE);
  if (stored) {
    const raw = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  localStorage.setItem(KEY_STORAGE, btoa(String.fromCharCode(...new Uint8Array(raw))));
  return key;
}

export async function encryptString(plain) {
  const key = await getKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plain);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined));
}

export async function decryptString(payload) {
  const key = await getKey();
  const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}
