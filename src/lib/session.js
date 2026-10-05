// src/lib/session.js
// The signed-in crew session as lib/api.js sees it. Native build: the
// expo-auth-session login in ./auth. The web build resolves session.web.js
// instead (Metro and vite.config.js both prefer .web.js on web).
import { authHeader } from "./auth";

export { isAuthenticated, myCrewId, currentUsername, logout } from "./auth";

export async function freshAuthHeader() {
  return authHeader(); // ./auth refreshes the token on its own timer
}
