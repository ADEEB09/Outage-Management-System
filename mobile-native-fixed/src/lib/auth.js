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

export async function isBiometricEnabled() {
  return (await SafeStore.getItemAsync("oms_biometric_enabled")) === "true";
}

export async function setBiometricEnabled(enabled) {
  if (enabled) await SafeStore.setItemAsync("oms_biometric_enabled", "true");
  else await SafeStore.deleteItemAsync("oms_biometric_enabled");
}
