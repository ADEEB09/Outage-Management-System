// src/lib/auth.js
// Keycloak login via an in-app WebView loading Keycloak's real hosted login
// page directly -- the same page the web app uses -- rather than handing off
// to the OS browser + a custom URL scheme. This avoids Expo Go's dev-time
// redirect proxy entirely, which is what "exp://..." / "Invalid parameter:
// redirect_uri" failures were coming from.
//
// Flow: build the Keycloak authorization URL with PKCE -> render it in a
// WebView (see components/LoginWebView.jsx) -> watch navigation for our
// fixed, non-scheme redirect_uri -> pull the `code` off that URL -> exchange
// it for tokens here, exactly like the web app's own login already does.
import { Platform } from "react-native";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { KEYCLOAK_URL, REALM, CLIENT_ID } from "../config";
import { encryptString, decryptString } from "./webCrypto";

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

// A fixed, non-scheme redirect URI. It never actually has to load anything --
// the WebView intercepts navigation to it before the request completes -- so
// it just needs to be registered verbatim in the Keycloak client's "Valid
// redirect URIs" list.
export const redirectUri = "https://oms-upcl.local/mobile-callback";

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

function base64UrlEncode(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomVerifier() {
  const bytes = Crypto.getRandomBytes(32);
  return base64UrlEncode(bytes);
}

async function challengeFor(verifier) {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    verifier,
    { encoding: Crypto.CryptoEncoding.BASE64 }
  );
  return digest.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds the full Keycloak login URL (PKCE) to hand to the WebView, plus the
// matching code_verifier to keep around for the token exchange once the
// WebView reports back an authorization code.
export async function buildAuthRequest() {
  const codeVerifier = randomVerifier();
  const codeChallenge = await challengeFor(codeVerifier);
  const state = randomVerifier();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  return {
    authUrl: `${discovery.authorizationEndpoint}?${params.toString()}`,
    codeVerifier,
    state,
  };
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

let refreshTimer = null;

// Keycloak access tokens are short-lived (typically ~5 min). Without this,
// a session left open for more than a few minutes — exactly what happens
// during a real device test — starts failing every API call and every
// background location ping with 401, silently, since both just log/queue
// the failure instead of surfacing it.
function scheduleTokenRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (!tokenParsed?.exp || !refreshToken) return;
  const msUntilExpiry = tokenParsed.exp * 1000 - Date.now();
  const delay = Math.max(msUntilExpiry - 60000, 5000); // refresh 60s before expiry
  refreshTimer = setTimeout(() => {
    refreshAccessToken().catch(() => {});
  }, delay);
}

export async function refreshAccessToken() {
  if (!refreshToken) return false;
  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json();
    if (!data.access_token) throw new Error("refresh failed");

    accessToken = data.access_token;
    refreshToken = data.refresh_token ?? refreshToken;
    tokenParsed = parseJwt(accessToken);

    await SafeStore.setItemAsync("oms_token", accessToken);
    if (data.refresh_token) await SafeStore.setItemAsync("oms_refresh_token", refreshToken);

    scheduleTokenRefresh();
    return true;
  } catch {
    // Refresh token itself expired/revoked — the crew will need to sign in
    // again; don't clear the session here so an in-flight request can still
    // try with the stale token rather than being force-logged-out mid-task.
    return false;
  }
}

// Called by LoginWebView once it has intercepted the redirect and pulled the
// `code` param off the URL. Returns true on success.
export async function completeLogin(code, codeVerifier) {
  const data = await exchangeCode(code, codeVerifier);
  if (!data.access_token) return false;

  accessToken = data.access_token;
  refreshToken = data.refresh_token ?? null;
  tokenParsed = parseJwt(accessToken);

  await SafeStore.setItemAsync("oms_token", accessToken);
  if (refreshToken) await SafeStore.setItemAsync("oms_refresh_token", refreshToken);
  scheduleTokenRefresh();
  return true;
}

// Attempt to restore a session from SecureStore (e.g. on app relaunch).
// Never throws -- always resolves to false on any failure so callers
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
    scheduleTokenRefresh();
    return true;
  } catch {
    return false;
  }
}

export function authHeader() {
  return accessToken ? { Authorization: "Bearer " + accessToken } : {};
}

// Standalone token fetch for code that may run in a headless JS context
// with no in-memory auth state — Android can wake the background location
// task in a fresh JS instance after the app process was killed, where the
// `accessToken`/`refreshToken` module variables above are simply unset.
// Reads straight from SecureStore, refreshing first if the stored token is
// expired or about to be, and persists any refreshed pair back to storage.
export async function getFreshAccessToken() {
  try {
    const stored = await SafeStore.getItemAsync("oms_token");
    if (!stored) return null;
    const parsed = parseJwt(stored);
    const expiresAtMs = (parsed?.exp ?? 0) * 1000;
    if (expiresAtMs && expiresAtMs - Date.now() > 30000) return stored;

    const storedRefresh = await SafeStore.getItemAsync("oms_refresh_token");
    if (!storedRefresh) return expiresAtMs > Date.now() ? stored : null;

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: storedRefresh,
    });
    const response = await fetch(discovery.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const data = await response.json();
    if (!data.access_token) return expiresAtMs > Date.now() ? stored : null;

    await SafeStore.setItemAsync("oms_token", data.access_token);
    if (data.refresh_token) await SafeStore.setItemAsync("oms_refresh_token", data.refresh_token);

    // Keep the in-memory singleton in sync too, in case this ran in the
    // same JS instance as the live app (the common case).
    accessToken = data.access_token;
    refreshToken = data.refresh_token ?? refreshToken;
    tokenParsed = parseJwt(accessToken);

    return data.access_token;
  } catch {
    return null;
  }
}

export function isAuthenticated() {
  return Boolean(accessToken);
}

const USER_TO_CREW = { "test.operator": "C003", "test.scada": "C002" };

export function myCrewId() {
  if (tokenParsed?.crew_id) return tokenParsed.crew_id;
  return USER_TO_CREW[tokenParsed?.preferred_username] || "C003";
}

export function currentUsername() {
  return tokenParsed?.preferred_username ?? tokenParsed?.name ?? null;
}

export async function logout() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  accessToken = null;
  refreshToken = null;
  tokenParsed = null;
  await SafeStore.deleteItemAsync("oms_token");
  await SafeStore.deleteItemAsync("oms_refresh_token");
}

export async function isBiometricEnabled() {
  return (await SafeStore.getItemAsync("oms_biometric_enabled")) === "true";
}

export async function setBiometricEnabled(enabled) {
  if (enabled) await SafeStore.setItemAsync("oms_biometric_enabled", "true");
  else await SafeStore.deleteItemAsync("oms_biometric_enabled");
}
