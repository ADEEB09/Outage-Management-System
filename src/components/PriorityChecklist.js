// src/components/PriorityChecklist.js
// Shows the pre-work checks a crew must review before heading to site,
// scaled to the incident's severity. Color coding:
//   High severity   -> orange
//   Medium severity  -> blue
//   Low severity     -> green
// (Critical reuses the High checklist with one extra escalation step, and
// keeps its own red badge to stay visually distinct from High.)
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

export const SEVERITY_COLORS = {
  Critical: "#d7382a",
  High: "#e08a1e",
  Medium: "#2f6fd6",
  Low: "#2a9d5c",
};

const CHECKLIST_ITEMS = {
  Critical: [
    "Notify control room / SCADA immediately",
    "Confirm outage isolated to feeder zone",
    "Check for critical infrastructure impact (hospitals, water, telecom)",
    "PPE Level 2 required",
    "Dispatch backup crew if ETA > 20 min",
  ],
  High: [
    "Notify control room / SCADA",
    "Confirm outage isolated to feeder zone",
    "Check for critical infrastructure impact (hospitals, water, telecom)",
    "PPE Level 2 required",
  ],
  Medium: [
    "Confirm feeder status with SCADA",
    "Verify standard PPE checked",
    "Update ETA to dispatch",
  ],
  Low: [
    "Log job details",
    "Verify standard PPE checked",
  ],
};

export default function PriorityChecklist({ severity = "Medium" }) {
  const color = SEVERITY_COLORS[severity] || SEVERITY_COLORS.Medium;
  const items = CHECKLIST_ITEMS[severity] || CHECKLIST_ITEMS.Medium;
  const [checked, setChecked] = useState({});

  return (
    <View style={[s.card, { borderColor: color }]}>
      <View style={s.headerRow}>
        <Text style={s.title}>Priority checklist</Text>
        <View style={[s.badge, { backgroundColor: color }]}>
          <Text style={s.badgeText}>{severity?.toUpperCase()}</Text>
        </View>
      </View>
      {items.map((item, i) => (
        <Pressable
          key={i}
          style={s.row}
          onPress={() => setChecked((prev) => ({ ...prev, [i]: !prev[i] }))}
        >
          <View style={[s.box, { borderColor: color }, checked[i] && { backgroundColor: color }]}>
            {checked[i] && <Text style={s.tick}>✓</Text>}
          </View>
          <Text style={s.label}>{item}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    padding: 16,
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1.5,
    gap: 10,
  },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 15, fontWeight: "700", color: "#0f1b2d" },
  badge: { borderRadius: 12, paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { color: "#fff", fontSize: 10, fontWeight: "800", letterSpacing: 0.5 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  tick: { color: "#fff", fontSize: 11, fontWeight: "800" },
  label: { fontSize: 13, flex: 1, color: "#33465f" },
});
