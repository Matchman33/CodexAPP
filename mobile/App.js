import { useEffect, useState } from "react";
import { View, ActivityIndicator, StyleSheet, Text, Pressable, Modal, ScrollView, Alert, SafeAreaView } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { StatusBar } from "expo-status-bar";
import { C } from "./src/theme";
import { loadProfile, saveProfile, clearProfile, profileReady, loadKeyPair } from "./src/storage";
import { useRelay } from "./src/useRelay";
import SetupScreen from "./src/SetupScreen";
import MainScreen from "./src/MainScreen";
import PairingScreen from "./src/PairingScreen";

function Connected({ profile, keypair, onForget }) {
  const relay = useRelay(profile, keypair);
  const [choosing, setChoosing] = useState(false);
  const current = relay.agents.find(agent => agent.id === relay.agentId);
  const select = id => {
    setChoosing(false);
    if (id === relay.agentId) return;
    if (!relay.agentId) { relay.selectAgent(id); return; }
    Alert.alert("切换电脑", "未发送的草稿将清除，原电脑上的任务继续运行。", [
      { text: "取消", style: "cancel" }, { text: "切换", onPress: () => relay.selectAgent(id) },
    ]);
  };
  return <SafeAreaView style={{ flex: 1 }}>
    {relay.cloud && <Pressable accessibilityRole="button" accessibilityLabel="选择电脑" onPress={() => setChoosing(true)} style={s.devices}>
      <Text numberOfLines={1} style={s.deviceText}>{current ? current.name : relay.agentId ? "已选电脑离线" : "选择电脑"}</Text>
      <Feather name="chevron-down" size={18} color={C.text} />
    </Pressable>}
    {relay.conn === "needPairing" ? <PairingScreen key={relay.agentId} relay={relay} onForget={onForget} /> : <MainScreen key={relay.agentId} relay={relay} onForget={onForget} />}
    <Modal visible={choosing} transparent animationType="fade" onRequestClose={() => setChoosing(false)}>
      <View style={s.overlay}><View style={s.deviceList}>
        <Text style={s.deviceText}>选择电脑</Text>
        <ScrollView>{relay.agents.map(agent => <Pressable key={agent.id} accessibilityRole="button" onPress={() => select(agent.id)} style={s.devices}>
          <Text style={s.deviceText}>{agent.name} · {agent.id.slice(0, 8)}{agent.id === relay.agentId ? "（当前）" : ""}</Text>
        </Pressable>)}</ScrollView>
        {!relay.agents.length && <Text style={s.deviceText}>暂无在线电脑</Text>}
        <Pressable accessibilityRole="button" onPress={() => setChoosing(false)} style={s.devices}><Text style={s.deviceText}>关闭</Text></Pressable>
      </View></View>
    </Modal>
  </SafeAreaView>;
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
  devices: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", padding: 14, gap: 10, borderBottomWidth: 1, borderBottomColor: C.line },
  deviceText: { color: C.text, fontSize: 15, flexShrink: 1 },
  overlay: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "#00000088" },
  deviceList: { maxHeight: "70%", backgroundColor: C.bg, borderRadius: 8, padding: 16 },
  app: { flex: 1, backgroundColor: C.bg },
  loading: { flex: 1, backgroundColor: C.bg, alignItems: "center", justifyContent: "center" },
});
