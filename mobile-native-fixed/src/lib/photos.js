// src/lib/photos.js
// expo-image-picker gives us the camera and returns base64 directly —
// exactly what the upload endpoint wants.
import * as ImagePicker from "expo-image-picker";
import { uploadJobPhoto } from "./api";
import { getLocation } from "./location";

export async function captureAndUpload(jobId, note) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera permission denied");

  const result = await ImagePicker.launchCameraAsync({
    base64: true,
    quality: 0.5, // keep upload small
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  const dataUrl = "data:image/jpeg;base64," + asset.base64;
  const loc = await getLocation();
  return uploadJobPhoto(jobId, dataUrl, loc, note);
}
