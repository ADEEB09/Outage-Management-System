// src/components/SafetyChecklist.js
// Native version of the web checklist. Blocks "Work Started" until every
// item is ticked.
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

const ITEMS = [
  "Line confirmed de-energised",
  "PPE worn",
  "Work area barricaded",
  "Permit verified",
];

export default function SafetyChecklist({ onPass, onCancel }) {
  const [checked, setChecked] = useState({});
  const allDone = ITEMS.every((_, i) => checked[i]);

  return (
    <View style={s.card}>
      <Text style={s.title}>Safety checklist</Text>
      {ITEMS.map((item, i) => (
        <Pressable
          key={i}
          style={s.row}
          onPress={() => setChecked({ ...checked, [i]: !checked[i] })}
        >
          <View style={[s.box, checked[i] && s.boxOn]}>
            {checked[i] && <Text style={s.tick}>OK</Text>}
          </View>
          <Text style={s.label}>{item}</Text>
        </Pressable>
      ))}
      <Pressable
        disabled={!allDone}
        style={[s.btn, !allDone && s.btnOff]}
        onPress={onPass}
      >
        <Text style={s.btnText}>Confirm &amp; start work</Text>
      </Pressable>
      {onCancel && (
        <Pressable style={s.cancelBtn} onPress={onCancel}>
          <Text style={s.cancelText}>Cancel</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 10 },
  title: { fontSize: 16, fontWeight: "700", color: "#1F3864" },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: {
    width: 22,
    height: 22,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#1F3864",
    alignItems: "center",
    justifyContent: "center",
  },
  boxOn: { backgroundColor: "#1F3864" },
  tick: { color: "#fff", fontSize: 10, fontWeight: "700" },
  label: { fontSize: 14, flex: 1 },
  btn: {
    marginTop: 8,
    backgroundColor: "#1F3864",
    padding: 12,
    borderRadius: 8,
    alignItems: "center",
  },
  btnOff: { backgroundColor: "#aaa" },
  btnText: { color: "#fff", fontWeight: "700" },
  cancelBtn: { alignItems: "center", paddingVertical: 6 },
  cancelText: { color: "#7c8da3", fontWeight: "600", fontSize: 13 },
});
