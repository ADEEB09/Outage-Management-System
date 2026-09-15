// src/lib/navigate.js
// Opens the native maps app on mobile and a browser maps link on web.
import { Linking, Platform } from "react-native";

export function navigateTo(address) {
  const q = encodeURIComponent(address);
  const mapsUrl = "https://www.google.com/maps/dir/?api=1&destination=" + q;

  if (Platform.OS === "web") {
    window.open(mapsUrl, "_blank", "noopener,noreferrer");
    return Promise.resolve(mapsUrl);
  }

  const url = Platform.select({
    ios: `maps://?daddr=${q}`,
    android: `google.navigation:q=${q}`,
  });

  return Linking.openURL(url || mapsUrl).catch(() =>
    Linking.openURL(mapsUrl)
  );
}
