import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { StatusBar } from "expo-status-bar";
import { C } from "./src/theme";
import { loadProfile, saveProfile, clearProfile, profileReady, loadKeyPair } from "./src/storage";
import { useRelay } from "./src/useRelay";
import SetupScreen from "./src/SetupScreen";
import MainScreen from "./src/MainScreen";
import PairingScreen from "./src/PairingScreen";

function Connected({ profile, keypair, onForget }) {
  const relay = useRelay(profile, keypair);
  if (relay.conn === "needPairing") return <PairingScreen relay={relay} onForget={onForget} />;
  return <MainScreen relay={relay} onForget={onForget} />;
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState(null);
  const [keypair, setKeypair] = useState(null);

  useEffect(() => {
    Promise.all([loadProfile(), loadKeyPair()]).then(([p, k]) => { setProfile(p); setKeypair(k); setReady(true); });
  }, []);

  const onConnect = async (p) => { await saveProfile(p); setProfile(p); };
  const onForget = async () => { await clearProfile(); setProfile((p) => ({ ...p, token: "", password: "" })); };

  if (!ready || !keypair) {
    return (<View style={s.loading}><StatusBar style="light" /><ActivityIndicator color={C.accent} /></View>);
  }

  return (
    <View style={s.app}>
      <StatusBar style="light" />
      {profileReady(profile)
        ? <Connected profile={profile} keypair={keypair} onForget={onForget} />
        : <SetupScreen initial={profile} onConnect={onConnect} />}
    </View>
  );
}

const s = StyleSheet.create({
  app: { flex: 1, backgroundColor: C.bg },
  loading: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" },
});
