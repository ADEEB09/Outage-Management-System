// src/lib/photos.js
// expo-image-picker gives us the camera and returns base64 directly —
// exactly what the upload endpoint wants.
import * as ImagePicker from "expo-image-picker";
import { uploadJobPhoto } from "./api";
import { getLocation } from "./location";

async function uriToDataUrl(uri) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("Could not read the captured photo");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not convert the captured photo"));
    };
    reader.onerror = () => reject(new Error("Could not convert the captured photo"));
    reader.readAsDataURL(blob);
  });
}

async function uploadCapturedPhoto(jobId, photo, note, technician = {}) {
  const loc = await getLocation({ allowCached: false });
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
    throw new Error("Location not available. Photo was not uploaded. Enable GPS and try again.");
  }
  const dataUrl = photo?.base64
    ? "data:image/jpeg;base64," + photo.base64
    : photo?.uri
      ? await uriToDataUrl(photo.uri)
      : null;
  if (!dataUrl) throw new Error("Camera did not return image data");
  return uploadJobPhoto(jobId, dataUrl, loc, note, {
    capturedAt: new Date().toISOString(),
    technicianId: technician.id ?? null,
    metadata: {
      technicianName: technician.name ?? null,
      cameraMode: "CameraView",
      width: photo.width ?? null,
      height: photo.height ?? null,
    },
  });
}

export { uploadCapturedPhoto };

export async function captureAndUpload(jobId, note, technician = {}) {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error("Camera permission denied");

  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ImagePicker.MediaType.Images,
    base64: true,
    exif: true,
    quality: 0.5, // keep upload small
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  const dataUrl = "data:image/jpeg;base64," + asset.base64;
  const loc = await getLocation({ allowCached: false });
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
    throw new Error("Location not available. Photo was not uploaded. Enable GPS and try again.");
  }
  return uploadJobPhoto(jobId, dataUrl, loc, note, {
    capturedAt: new Date().toISOString(),
    technicianId: technician.id ?? null,
    metadata: {
      technicianName: technician.name ?? null,
      cameraExif: asset.exif ?? {},
      fileName: asset.fileName ?? null,
      width: asset.width ?? null,
      height: asset.height ?? null,
    },
  });
}
