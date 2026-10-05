// src/lib/webAuth.js
// Keycloak login for the web (Vite PWA) build — the browser counterpart of
// lib/auth.js, which relies on expo-auth-session/expo-secure-store and only
// runs natively. Same realm, same `oms-mobile` client and same crew accounts,
// so the web app signs in as the same crew and calls the same backend routes.
//
// Keycloak is expected on this page's host at KEYCLOAK_PORT (the PC running
// the stack). keycloak-js needs a secure context for PKCE, so open the web
// app on http://localhost (or HTTPS), not a bare LAN IP over http.
import Keycloak from "keycloak-js";
import { CLIENT_ID, KEYCLOAK_PORT, REALM } from "../config";

const keycloakUrl = `${window.location.protocol}//${window.location.hostname}:${KEYCLOAK_PORT}`;
const keycloak = new Keycloak({ url: keycloakUrl, realm: REALM, clientId: CLIENT_ID });

let initPromise = null;

// Keycloak unreachable must not become a redirect to a dead page, so probe it
// first. `no-cors` resolves (opaque) whenever the server answers at all.
async function keycloakReachable() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`${keycloakUrl}/realms/${REALM}`, { mode: "no-cors", signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Resolves to { reachable, authenticated }. Restores an existing Keycloak
// session (and finishes a login redirect) without showing a login page.
export function initWebAuth() {
  if (!initPromise) {
    initPromise = (async () => {
      if (!(await keycloakReachable())) return { reachable: false, authenticated: false };
      try {
        const authenticated = await keycloak.init({
          onLoad: "check-sso",
          pkceMethod: "S256",
          checkLoginIframe: false,
        });
        return { reachable: true, authenticated };
      } catch {
        return { reachable: false, authenticated: false };
      }
    })();
  }
  return initPromise;
}

export function login() {
  return keycloak.login();
}

export function isAuthenticated() {
  return Boolean(keycloak.authenticated && keycloak.token);
}

// Refreshes the access token first when it is about to expire.
export async function freshAuthHeader() {
  if (!keycloak.authenticated) return {};
  try {
    await keycloak.updateToken(30);
  } catch {
    // Refresh token expired: send the stale token; the backend answers 401.
  }
  return keycloak.token ? { Authorization: "Bearer " + keycloak.token } : {};
}

// Same mapping as lib/auth.js: crew_id claim first, then the demo usernames.
const USER_TO_CREW = { "test.operator": "C003", "test.scada": "C002" };

export function myCrewId() {
  const token = keycloak.tokenParsed;
  if (token?.crew_id) return token.crew_id;
  return USER_TO_CREW[token?.preferred_username] || "C003";
}

export function currentUsername() {
  return keycloak.tokenParsed?.preferred_username ?? keycloak.tokenParsed?.name ?? null;
}

export function logout() {
  return keycloak.logout({ redirectUri: window.location.origin + "/" });
}
