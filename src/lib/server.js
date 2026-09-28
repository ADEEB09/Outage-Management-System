// src/lib/server.js
// The OMS server the app talks to (backend API + Keycloak on one host).
// Defaults to DEFAULT_SERVER from config.js; the sign-in screen can change
// it, and the choice is persisted so it survives restarts and is also seen
// by the headless background-location task.
//
// Call `await loadServer()` before the first request in any entry point
// (app start, background task). It is memoized, so repeat calls are free.
import AsyncStorage from "@react-native-async-storage/async-storage";
import { API_PORT, DEFAULT_SERVER, KEYCLOAK_PORT, REALM } from "../config";

const SERVER_KEY = "oms-server-host";
// A bare hostname or IPv4 address. Ports are fixed (API_PORT, KEYCLOAK_PORT).
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

let host = DEFAULT_SERVER;
let loadPromise = null;

// Accepts what a tester is likely to type ("http://192.168.1.20:4000/api",
// " 192.168.1.20 ") and returns just the host, or null if it isn't one.
export function normalizeServer(input) {
  const value = String(input ?? "")
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/[/:].*$/, "");
  return HOST_RE.test(value) ? value : null;
}

export function loadServer() {
  if (!loadPromise) {
    loadPromise = AsyncStorage.getItem(SERVER_KEY)
      .then((stored) => {
        const saved = normalizeServer(stored);
        if (saved) host = saved;
        return host;
      })
      .catch(() => host);
  }
  return loadPromise;
}

export async function setServer(input) {
  const next = normalizeServer(input);
  if (!next) throw new Error("Enter the server's IP address or hostname, e.g. 192.168.1.20");
  host = next;
  loadPromise = Promise.resolve(host);
  await AsyncStorage.setItem(SERVER_KEY, host).catch(() => {});
  return host;
}

export const getServer = () => host;
export const apiBase = () => `http://${host}:${API_PORT}/api`;
export const keycloakUrl = () => `http://${host}:${KEYCLOAK_PORT}`;

// Quick reachability check for the sign-in screen, so a tester can tell a
// wrong IP / firewall / stopped service apart from a wrong password.
export async function checkServer() {
  const probe = async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
  const [api, keycloak] = await Promise.all([
    probe(`${apiBase()}/health`),
    probe(`${keycloakUrl()}/realms/${REALM}/.well-known/openid-configuration`),
  ]);
  return { api, keycloak };
}
