// src/components/QrScanner.js
// expo-camera has a built-in barcode/QR scanner — no extra library needed.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

export default function QrScanner({ onScan, onClose }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [done, setDone] = useState(false);

  if (!perm) return <Text>Loading camera…</Text>;
  if (!perm.granted) {
    return (
      <View style={s.center}>
        <Text style={s.msg}>Camera access is needed to scan asset tags.</Text>
        <Pressable style={s.btn} onPress={requestPerm}>
          <Text style={s.btnText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.wrap}>
      <CameraView
        style={{ flex: 1 }}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={
          done
            ? undefined
            : ({ data }) => {
                setDone(true);
                onScan(data);
              }
        }
      />
      {onClose && (
        <Pressable style={s.closeBtn} onPress={onClose}>
          <Text style={s.closeText}>Cancel</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, minHeight: 320, borderRadius: 12, overflow: "hidden" },
  center: { padding: 24, alignItems: "center", gap: 12 },
  msg: { textAlign: "center", color: "#33465f" },
  btn: { backgroundColor: "#1F3864", paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8 },
  btnText: { color: "#fff", fontWeight: "700" },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  closeText: { color: "#fff", fontWeight: "700" },
});
