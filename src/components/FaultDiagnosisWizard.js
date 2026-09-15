// src/components/FaultDiagnosisWizard.js
// A 3-step wizard the crew works through before closing out a job:
// symptom -> likely cause -> recommended action. Produces a small
// diagnosis summary that gets attached to the completion record.
import { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

const STEPS = [
  {
    key: "symptom",
    question: "What was the primary symptom?",
    options: [
      "No power at all",
      "Partial outage",
      "Flickering / voltage fluctuation",
      "Visible equipment damage",
      "Other",
    ],
  },
  {
    key: "cause",
    question: "What was the likely cause?",
    options: [
      "Blown fuse",
      "Transformer failure",
      "Line down / broken conductor",
      "Loose connection",
      "Weather damage",
      "Unknown — needs further inspection",
    ],
  },
  {
    key: "action",
    question: "What action was taken?",
    options: [
      "Replaced fuse",
      "Replaced / repaired transformer",
      "Repaired / reconnected line",
      "Tightened / replaced connection",
      "Escalated to specialist crew",
    ],
  },
];

export default function FaultDiagnosisWizard({ onComplete, onCancel }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [answers, setAnswers] = useState({});

  const step = STEPS[stepIndex];
  const selected = answers[step.key];
  const isLast = stepIndex === STEPS.length - 1;

  const choose = (option) => setAnswers((prev) => ({ ...prev, [step.key]: option }));

  const next = () => {
    if (!selected) return;
    if (isLast) {
      onComplete(answers);
      return;
    }
    setStepIndex((i) => i + 1);
  };

  const back = () => {
    if (stepIndex === 0) {
      onCancel?.();
      return;
    }
    setStepIndex((i) => i - 1);
  };

  return (
    <View style={s.card}>
      <View style={s.headerRow}>
        <Text style={s.title}>Fault diagnosis</Text>
        <Text style={s.stepCount}>{stepIndex + 1} / {STEPS.length}</Text>
      </View>
      <Text style={s.question}>{step.question}</Text>
      {step.options.map((option) => (
        <Pressable
          key={option}
          style={[s.option, selected === option && s.optionOn]}
          onPress={() => choose(option)}
        >
          <Text style={[s.optionText, selected === option && s.optionTextOn]}>{option}</Text>
        </Pressable>
      ))}
      <View style={s.navRow}>
        <Pressable style={s.backBtn} onPress={back}>
          <Text style={s.backBtnText}>{stepIndex === 0 ? "Cancel" : "Back"}</Text>
        </Pressable>
        <Pressable style={[s.nextBtn, !selected && s.nextBtnOff]} disabled={!selected} onPress={next}>
          <Text style={s.nextBtnText}>{isLast ? "Confirm diagnosis" : "Next"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { padding: 16, backgroundColor: "#fff", borderRadius: 12, gap: 10, borderWidth: 1, borderColor: "#e6ecf3" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontSize: 15, fontWeight: "700", color: "#0f1b2d" },
  stepCount: { fontSize: 11, color: "#7c8da3", fontWeight: "700" },
  question: { fontSize: 13, color: "#33465f", fontWeight: "600", marginBottom: 2 },
  option: { borderWidth: 1.5, borderColor: "#e6ecf3", borderRadius: 8, padding: 10 },
  optionOn: { borderColor: "#1F3864", backgroundColor: "#eef2f8" },
  optionText: { fontSize: 13, color: "#33465f" },
  optionTextOn: { color: "#1F3864", fontWeight: "700" },
  navRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  backBtn: { flex: 1, alignItems: "center", padding: 11, borderRadius: 8, borderWidth: 1, borderColor: "#c7d0dc" },
  backBtnText: { color: "#7c8da3", fontWeight: "700" },
  nextBtn: { flex: 2, alignItems: "center", padding: 11, borderRadius: 8, backgroundColor: "#1F3864" },
  nextBtnOff: { backgroundColor: "#aab4c2" },
  nextBtnText: { color: "#fff", fontWeight: "800" },
});
