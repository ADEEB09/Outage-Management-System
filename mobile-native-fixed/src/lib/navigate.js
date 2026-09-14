// src/lib/navigate.js
// Opens the phone's native maps app — no map SDK / API key needed.
import { Linking, Platform } from "react-native";

export function navigateTo(address) {
  const q = encodeURIComponent(address);
  const url = Platform.select({
    ios: `maps://?daddr=${q}`,
    android: `google.navigation:q=${q}`,
  });
  return Linking.openURL(url).catch(() =>
    Linking.openURL("https://www.google.com/maps/dir/?api=1&destination=" + q)
  );
}
