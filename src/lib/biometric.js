// src/lib/biometric.js
// Optional: gate the app behind fingerprint/face after the first Keycloak
// login, using the token already saved in SecureStore. Requires:
//   npx expo install expo-local-authentication
import * as LocalAuthentication from "expo-local-authentication";

export async function biometricUnlock() {
  const has = await LocalAuthentication.hasHardwareAsync();
  if (!has) return true; // no biometric hardware -> skip
  const enrolled = await LocalAuthentication.isEnrolledAsync();
  if (!enrolled) return true; // hardware present but nothing enrolled -> skip

  const res = await LocalAuthentication.authenticateAsync({
    promptMessage: "Unlock OMS Crew",
  });
  return res.success;
}
