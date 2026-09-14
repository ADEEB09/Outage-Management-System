// src/components/LoginWebView.jsx
// Renders Keycloak's real, themed login page inside the app -- the exact
// same page the web app shows in a browser tab -- and watches navigation
// for our redirect_uri to pull the authorization code off it directly.
// No OS-level URL scheme / deep link involved, so nothing here depends on
// Expo Go's development redirect proxy.
import { useEffect, useState } from "react";
import { Modal, View, ActivityIndicator, Text, Pressable, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";
import { buildAuthRequest, completeLogin, redirectUri } from "../lib/auth";

export default function LoginWebView({ visible, onSuccess, onCancel }) {
  const [authUrl, setAuthUrl] = useState(null);
  const [codeVerifier, setCodeVerifier] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setAuthUrl(null);
    buildAuthRequest().then(({ authUrl, codeVerifier }) => {
      setAuthUrl(authUrl);
      setCodeVerifier(codeVerifier);
    });
  }, [visible]);

  const handleNavChange = async (navState) => {
    const url = navState.url || "";
    if (!url.startsWith(redirectUri)) return;

    try {
      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");
      const errParam = parsed.searchParams.get("error");
      if (errParam) {
        setError(errParam);
        return;
      }
      if (!code) return;

      setBusy(true);
      const ok = await completeLogin(code, codeVerifier);
      setBusy(false);
      if (ok) onSuccess();
      else setError("Sign-in did not return a valid token.");
    } catch {
      setBusy(false);
      setError("Could not complete sign-in.");
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={styles.header}>
        <Pressable onPress={onCancel} style={styles.closeBtn}>
          <Text style={styles.closeText}>Cancel</Text>
        </Pressable>
        <Text style={styles.headerTitle}>Sign in</Text>
        <View style={{ width: 60 }} />
      </View>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable onPress={onCancel} style={styles.retryBtn}>
            <Text style={styles.retryText}>Close</Text>
          </Pressable>
        </View>
      ) : !authUrl ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#0e9f8e" />
        </View>
      ) : (
        <>
          <WebView
            source={{ uri: authUrl }}
            onNavigationStateChange={handleNavChange}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.center}>
                <ActivityIndicator size="large" color="#0e9f8e" />
              </View>
            )}
          />
          {busy && (
            <View style={styles.overlay}>
              <ActivityIndicator size="large" color="#fff" />
              <Text style={styles.overlayText}>Signing in...</Text>
            </View>
          )}
        </>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 54,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: "#0a1c33",
  },
  closeBtn: { width: 60 },
  closeText: { color: "#7ea6f7", fontSize: 15 },
  headerTitle: { color: "#fff", fontSize: 15, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#05050a" },
  errorText: { color: "#f0a0a0", fontSize: 14, textAlign: "center", paddingHorizontal: 24, marginBottom: 16 },
  retryBtn: { backgroundColor: "#0e9f8e", paddingHorizontal: 20, paddingVertical: 10, borderRadius: 980 },
  retryText: { color: "#fff", fontWeight: "600" },
  overlay: {
    position: "absolute", inset: 0,
    backgroundColor: "rgba(5,5,10,0.75)",
    alignItems: "center", justifyContent: "center",
  },
  overlayText: { color: "#fff", marginTop: 12, fontSize: 14 },
});
