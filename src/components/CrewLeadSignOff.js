// src/components/CrewLeadSignOff.js
// Final gate before a job can be marked complete: the crew lead types
// their name and confirms the work was done safely and correctly.
import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet } from "react-native";

export default function CrewLeadSignOff({ defaultName = "", onComplete, onCancel }) {
  const [name, setName] = useState(defaultName);
  const [confirmed, setConfirmed] = useState(false);

  const canSubmit = name.trim().length > 1 && confirmed;

  return (
    <View style={s.card}>
      <Text style={s.title}>Crew-lead sign-off</Text>
      <Text style={s.label}>Crew lead name</Text>
      <TextInput
        style={s.input}
        value={name}
        onChangeText={setName}
        placeholder="Enter full name"
        placeholderTextColor="#9aa8bb"
      />

      <Pressable style={s.checkRow} onPress={() => setConfirmed((v) => !v)}>
        <View style={[s.checkbox, confirmed && s.checkboxOn]}>
          {confirmed && <Text style={s.checkTick}>✓</Text>}
        </View>
        <Text style={s.checkLabel}>
          I confirm the work described above was completed safely and correctly, and the
          site has been left in a safe condition.
        </Text>
      </Pressable>

      <View style={s.navRow}>
        <Pressable style={s.backBtn} onPress={onCancel}>
          <Text style={s.backBtnText}>Back</Text>
        </Pressable>
        <Pressable
          style={[s.nextBtn, !canSubmit && s.nextBtnOff]}
          disabled={!canSubmit}
          onPress={() => onComplete({ name: name.trim(), signedAt: new Date().toISOString() })}
        >
          <Text style={s.nextBtnText}>Sign off &amp; complete job</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 12, borderWidth: 1, borderColor: "#e6ecf3" },
  title: { fontSize: 15, fontWeight: "700", color: "#0f1b2d" },
  label: { fontSize: 11, fontWeight: "800", color: "#7c8da3", letterSpacing: 0.5 },
  input: {
    borderWidth: 1.5,
    borderColor: "#c7d0dc",
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    color: "#0f1b2d",
  },
  checkRow: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: "#1F3864",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  checkboxOn: { backgroundColor: "#1F3864" },
  checkTick: { color: "#fff", fontSize: 11, fontWeight: "800" },
  checkLabel: { flex: 1, fontSize: 12, color: "#33465f", lineHeight: 17 },
  navRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  backBtn: { flex: 1, alignItems: "center", padding: 11, borderRadius: 8, borderWidth: 1, borderColor: "#c7d0dc" },
  backBtnText: { color: "#7c8da3", fontWeight: "700" },
  nextBtn: { flex: 2, alignItems: "center", padding: 11, borderRadius: 8, backgroundColor: "#1F3864" },
  nextBtnOff: { backgroundColor: "#aab4c2" },
  nextBtnText: { color: "#fff", fontWeight: "800" },
});
