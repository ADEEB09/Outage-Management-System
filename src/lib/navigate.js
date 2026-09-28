// src/lib/navigate.js
// Opens the native maps app on mobile and a browser maps link on web.
import { Linking, Platform } from "react-native";

const finite = (n) => typeof n === "number" && Number.isFinite(n);

// Coordinates are preferred over the address: Google Maps can route to a
// lat,lon with no internet if the crew downloaded that area as an offline
// map, whereas an address needs an online lookup first.
export function navigateTo(address, coords) {
  const hasCoords = finite(coords?.lat) && finite(coords?.lon);
  const q = hasCoords ? `${coords.lat},${coords.lon}` : encodeURIComponent(address);
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
