// src/components/PartsPicker.js
// Lets the crew log which parts/materials were used to close out a job,
// with a simple +/- quantity stepper per part.
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

const CATALOG = [
  { id: "fuse-11kv", name: "11kV fuse" },
  { id: "transformer", name: "Distribution transformer" },
  { id: "conductor", name: "ACSR conductor (per meter)" },
  { id: "insulator", name: "Insulator" },
  { id: "jumper", name: "Jumper cable" },
  { id: "breaker", name: "Circuit breaker" },
];

export default function PartsPicker({ onComplete, onCancel }) {
  const [qty, setQty] = useState({});

  const change = (id, delta) =>
    setQty((prev) => ({ ...prev, [id]: Math.max(0, (prev[id] || 0) + delta) }));

  const usedParts = CATALOG.filter((p) => qty[p.id] > 0).map((p) => ({ name: p.name, qty: qty[p.id] }));

  return (
    <View style={s.card}>
      <Text style={s.title}>Parts used</Text>
      {CATALOG.map((part) => (
        <View key={part.id} style={s.row}>
          <Text style={s.partName}>{part.name}</Text>
          <View style={s.stepper}>
            <Pressable style={s.stepBtn} onPress={() => change(part.id, -1)}>
              <Text style={s.stepBtnText}>−</Text>
            </Pressable>
            <Text style={s.stepValue}>{qty[part.id] || 0}</Text>
            <Pressable style={s.stepBtn} onPress={() => change(part.id, 1)}>
              <Text style={s.stepBtnText}>+</Text>
            </Pressable>
          </View>
        </View>
      ))}
      <View style={s.navRow}>
        <Pressable style={s.backBtn} onPress={onCancel}>
          <Text style={s.backBtnText}>Back</Text>
        </Pressable>
        <Pressable style={s.nextBtn} onPress={() => onComplete(usedParts)}>
          <Text style={s.nextBtnText}>
            {usedParts.length ? `Confirm ${usedParts.length} part(s)` : "No parts used — continue"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 12, borderWidth: 1, borderColor: "#e6ecf3" },
  title: { fontSize: 15, fontWeight: "700", color: "#0f1b2d" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  partName: { fontSize: 13, color: "#33465f", flex: 1, paddingRight: 10 },
  stepper: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepBtn: { width: 28, height: 28, borderRadius: 6, borderWidth: 1, borderColor: "#1F3864", alignItems: "center", justifyContent: "center" },
  stepBtnText: { color: "#1F3864", fontSize: 16, fontWeight: "800", lineHeight: 18 },
  stepValue: { minWidth: 20, textAlign: "center", fontWeight: "700", color: "#0f1b2d" },
  navRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  backBtn: { flex: 1, alignItems: "center", padding: 11, borderRadius: 8, borderWidth: 1, borderColor: "#c7d0dc" },
  backBtnText: { color: "#7c8da3", fontWeight: "700" },
  nextBtn: { flex: 2, alignItems: "center", padding: 11, borderRadius: 8, backgroundColor: "#1F3864" },
  nextBtnText: { color: "#fff", fontWeight: "800" },
});
