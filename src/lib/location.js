// src/lib/location.js
// Native location via expo-location. Used to tag status updates and
// photo uploads with GPS coordinates.
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_LOCATION_KEY = "oms-last-known-location";

export async function getLocation({ allowCached = true } = {}) {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return {};
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    });
    const location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    await AsyncStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location));
    return location;
  } catch {
    return allowCached ? getLastKnownLocation() : {};
  }
}

export async function getLastKnownLocation() {
  try {
    const stored = await AsyncStorage.getItem(LAST_LOCATION_KEY);
    const location = stored ? JSON.parse(stored) : null;
    return Number.isFinite(location?.lat) && Number.isFinite(location?.lon) ? location : {};
  } catch {
    return {};
  }
}
