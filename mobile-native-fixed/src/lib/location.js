// src/lib/location.js
// Native location via expo-location. Used to tag status updates and
// photo uploads with GPS coordinates.
import * as Location from "expo-location";

export async function getLocation() {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return {};
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    return { lat: pos.coords.latitude, lon: pos.coords.longitude };
  } catch {
    return {};
  }
}
