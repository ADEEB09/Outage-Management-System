// src/lib/lockout.js
// Client-side account lockout after repeated failed Keycloak sign-in
// attempts, so a lost/stolen device can't be used to brute-force crew
// credentials while offline or before Keycloak's own server-side brute
// force protection kicks in. This is an additional local layer, not a
// replacement for Keycloak's own protections.
import AsyncStorage from "@react-native-async-storage/async-storage";

const ATTEMPTS_KEY = "oms-login-attempts";
const LOCK_UNTIL_KEY = "oms-login-lock-until";

export const MAX_ATTEMPTS = 5;
export const LOCKOUT_MS = 5 * 60 * 1000; // 5 minutes

export async function getLockoutStatus() {
  try {
    const storedLockUntil = Number((await AsyncStorage.getItem(LOCK_UNTIL_KEY)) || 0);
    const storedAttempts = Number((await AsyncStorage.getItem(ATTEMPTS_KEY)) || 0);
    const lockUntil = Number.isFinite(storedLockUntil) && storedLockUntil > 0 ? storedLockUntil : 0;
    const attempts = Number.isFinite(storedAttempts) && storedAttempts >= 0 ? storedAttempts : 0;
    const remainingMs = lockUntil - Date.now();
    if (remainingMs > 0 && attempts >= MAX_ATTEMPTS) {
      return { locked: true, remainingMs, attempts };
    }
    if (lockUntil || storedAttempts !== attempts) {
      await AsyncStorage.removeItem(LOCK_UNTIL_KEY);
      if (storedAttempts !== attempts) await AsyncStorage.setItem(ATTEMPTS_KEY, String(attempts));
    }
    return { locked: false, remainingMs: 0, attempts };
  } catch {
    return { locked: false, remainingMs: 0, attempts: 0 };
  }
}

export async function recordFailedAttempt() {
  try {
    const attempts = Number((await AsyncStorage.getItem(ATTEMPTS_KEY)) || 0) + 1;
    await AsyncStorage.setItem(ATTEMPTS_KEY, String(attempts));
    if (attempts >= MAX_ATTEMPTS) {
      await AsyncStorage.setItem(LOCK_UNTIL_KEY, String(Date.now() + LOCKOUT_MS));
    }
  } catch {
    // ignore storage errors; fail open rather than block sign-in entirely
  }
  return getLockoutStatus();
}

export async function resetAttempts() {
  try {
    await AsyncStorage.removeItem(ATTEMPTS_KEY);
    await AsyncStorage.removeItem(LOCK_UNTIL_KEY);
  } catch {
    // ignore
  }
}
