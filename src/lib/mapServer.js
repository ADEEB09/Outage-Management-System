// src/lib/mapServer.js
// Where the offline map pack and GPS uploads go, and how to authenticate.
// With MAP_TEST_SERVER set (see config.js) requests go to the local test
// server with no login; otherwise to the real OMS backend with the crew's
// Keycloak bearer token.
import { MAP_TEST_SERVER } from "../config";
import { getFreshAccessToken } from "./auth";
import { apiBase, loadServer } from "./server";

export const usingMapTestServer = Boolean(MAP_TEST_SERVER);
export const mapApiBase = () => MAP_TEST_SERVER || apiBase();

// Request headers for map/tracking calls, or null when a login is required
// but there is no usable session. Also loads the saved server address, so
// callers (including the headless location task) can use mapApiBase() after.
export async function mapServerHeaders() {
  await loadServer();
  if (usingMapTestServer) return {};
  const token = await getFreshAccessToken();
  return token ? { Authorization: "Bearer " + token } : null;
}
