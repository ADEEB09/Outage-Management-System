// src/lib/auth.js
// Keycloak login via OAuth (expo-auth-session). Token stored securely.
// This is the native equivalent of the web app's keycloak-js session.
import { Platform } from "react-native";
import * as AuthSession from "expo-auth-session";
import * as SecureStore from "expo-secure-store";
import { KEYCLOAK_URL, REALM, CLIENT_ID, REDIRECT_SCHEME } from "../config";
import { encryptString, decryptString } from "./webCrypto";

// Encrypted, persistent token storage on both platforms:
//   - Native: expo-secure-store, backed by the OS Keychain/Keystore
//     (hardware-protected on most devices).
//   - Web: expo-secure-store isn't supported in the browser, so tokens are
//     AES-GCM encrypted (see webCrypto.js) before being written to
//     localStorage, and decrypted on read. Falls back to an in-memory-only
//     store if the browser's crypto API is unavailable, so a storage
//     failure degrades gracefully instead of hanging the app.
const IS_WEB = Platform.OS === "web";
const memoryStore = new Map();
const SafeStore = {
  async getItemAsync(key) {
    if (IS_WEB) {
      try {
        const stored = localStorage.getItem(key);
        if (!stored) return memoryStore.get(key) ?? null;
        return await decryptString(stored);
      } catch {
        return memoryStore.get(key) ?? null;
      }
    }
    return SecureStore.getItemAsync(key);
  },
  async setItemAsync(key, value) {
    if (IS_WEB) {
      try {
        localStorage.setItem(key, await encryptString(value));
      } catch {
        memoryStore.set(key, value);
      }
      return;
    }
    return SecureStore.setItemAsync(key, value);
  },
  async deleteItemAsync(key) {
    if (IS_WEB) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      memoryStore.delete(key);
      return;
    }
    return SecureStore.deleteItemAsync(key);
  },
};

export const discovery = {
  authorizationEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/auth`,
  tokenEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`,
  endSessionEndpoint: `${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/logout`,
};

export const redirectUri = AuthSession.makeRedirectUri({ scheme: REDIRECT_SCHEME });

let accessToken = null;
let refreshToken = null;
let tokenParsed = null;

export function getToken() {
  return accessToken;
}

function parseJwt(token) {
  try {
    const base64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(decodeURIComponent(escape(atob(base64))));
  } catch {
    return {};
  }
}

async function exchangeCode(code, codeVerifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const response = await fetch(discovery.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  return response.json();
}

// Call from a login screen with the `promptAsync`/`request` pair returned by
// `AuthSession.useAuthRequest`. Returns a result so callers can distinguish
// cancellation/network errors from an actual rejected sign-in.
export async function login(promptAsync, request) {
  const result = await promptAsync();
  if (result?.type !== "success") {
    return { success: false, countFailure: result?.type === "error" };
  }

  const data = await exchangeCode(result.params.code, request.codeVerifier);
  if (!data.access_token) return { success: false, countFailure: true };

  accessToken = data.access_token;
  refreshToken = data.refresh_token ?? null;
  tokenParsed = parseJwt(accessToken);

  await SafeStore.setItemAsync("oms_token", accessToken);
  if (refreshToken) await SafeStore.setItemAsync("oms_refresh_token", refreshToken);
  return { success: true };
}

// Attempt to restore a session from SecureStore (e.g. on app relaunch).
// Never throws — always resolves to false on any failure so callers
// (e.g. a startup spinner) can't hang waiting on this.
export async function restoreSession() {
  try {
    const stored = await SafeStore.getItemAsync("oms_token");
    if (!stored) return false;
    const parsed = parseJwt(stored);
    const expiresAtMs = (parsed?.exp ?? 0) * 1000;
    if (expiresAtMs && expiresAtMs < Date.now()) {
      await logout();
      return false;
    }
    accessToken = stored;
    tokenParsed = parsed;
    refreshToken = (await SafeStore.getItemAsync("oms_refresh_token")) ?? null;
    return true;
  } catch {
    return false;
  }
}

export function authHeader() {
  return accessToken ? { Authorization: "Bearer " + accessToken } : {};
}

export function isAuthenticated() {
  return Boolean(accessToken);
}

// Crew id: prefer a crew_id claim from the token, else map by username
// (matches the mapping used by the web app for the same demo accounts).
const USER_TO_CREW = { "test.operator": "C003", "test.scada": "C002" };

export function myCrewId() {
  if (tokenParsed?.crew_id) return tokenParsed.crew_id;
  return USER_TO_CREW[tokenParsed?.preferred_username] || "C003";
}

export function currentUsername() {
  return tokenParsed?.preferred_username ?? tokenParsed?.name ?? null;
}

export async function logout() {
  accessToken = null;
  refreshToken = null;
  tokenParsed = null;
  await SafeStore.deleteItemAsync("oms_token");
  await SafeStore.deleteItemAsync("oms_refresh_token");
}

// Whether the crew member has opted in to unlocking a restored session
// with Face ID / fingerprint instead of it being granted automatically.
export async function isBiometricEnabled() {
  return (await SafeStore.getItemAsync("oms_biometric_enabled")) === "true";
}

export async function setBiometricEnabled(enabled) {
  if (enabled) await SafeStore.setItemAsync("oms_biometric_enabled", "true");
  else await SafeStore.deleteItemAsync("oms_biometric_enabled");
}
