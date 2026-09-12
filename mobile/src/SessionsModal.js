import { useState } from "react";
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet, SafeAreaView } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { C } from "./theme";

export default function SessionsModal({ visible, tree, activeThreadId, onResume, onRefresh, onNewThread, onSettings, onClose }) {
  const [query, setQuery] = useState("");
  const search = query.trim().toLowerCase();
  const matches = (t) => !search || (t.name || "").toLowerCase().includes(search);
  const projects = (tree?.projects || []).map((p) => ({ ...p, threads: p.label.toLowerCase().includes(search) ? p.threads : p.threads.filter(matches) })).filter((p) => !search || p.threads.length);
  const projectless = (tree?.projectless || []).filter(matches);
  const item = (t) => <Pressable accessibilityRole="button" key={t.id} style={[s.item, t.id === activeThreadId && { backgroundColor: C.card2 }]} onPress={() => onResume(t.id)}><Text style={s.name} numberOfLines={1}>{t.name || "无标题"}</Text><Text style={s.meta}>{t.updatedAt ? new Date(t.updatedAt * 1000).toLocaleDateString("zh-CN", { month: "long", day: "numeric" }) : ""}</Text></Pressable>;
  return <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
    <View style={s.backdrop}>
      <SafeAreaView style={s.sheet}>
        <View style={s.header}><Text style={s.title}>CodexApp</Text><Pressable style={s.icon} accessibilityLabel="刷新会话列表" onPress={onRefresh}><Feather name="refresh-cw" size={20} color={C.text} /></Pressable><Pressable style={s.icon} accessibilityLabel="关闭会话列表" onPress={onClose}><Feather name="x" size={22} color={C.text} /></Pressable></View>
        <Pressable style={s.command} onPress={onNewThread}><Feather name="edit" size={20} color={C.text} /><Text style={s.name}>新对话</Text></Pressable>
        <View style={s.search}><Feather name="search" size={17} color={C.muted} /><TextInput style={s.input} accessibilityLabel="搜索对话" value={query} onChangeText={setQuery} placeholder="搜索对话" placeholderTextColor={C.muted} /></View>
        <ScrollView style={s.list}>
          {!projects.length && !projectless.length && <Text style={s.hint}>{search ? "没有匹配的对话" : "没有会话"}</Text>}
          {projects.map((p) => <View key={p.id || p.root}><View style={s.group}><Feather name="folder" size={14} color={C.muted} /><Text style={s.groupName} numberOfLines={1}>{p.label}  {p.threads.length}</Text></View>{!p.threads.length && <Text style={s.hint}>暂无对话</Text>}{p.threads.map(item)}</View>)}
          {!!projectless.length && <View><View style={s.group}><Feather name="message-square" size={14} color={C.muted} /><Text style={s.groupName}>对话  {projectless.length}</Text></View>{projectless.map(item)}</View>}
        </ScrollView>
        <Pressable style={s.command} onPress={onSettings}><Feather name="sliders" size={20} color={C.text} /><Text style={s.name}>设置</Text></Pressable>
      </SafeAreaView>
      <Pressable accessibilityLabel="关闭会话列表" style={{ flex: 1 }} onPress={onClose} />
    </View>
  </Modal>;
}
const s = StyleSheet.create({
  backdrop: { flex: 1, flexDirection: "row", backgroundColor: "rgba(0,0,0,0.5)" },
  sheet: { width: "86%", maxWidth: 320, backgroundColor: C.bg2, paddingHorizontal: 12 },
  header: { flexDirection: "row", alignItems: "center", paddingVertical: 12 },
  title: { color: C.text, fontSize: 18, fontWeight: "600", marginRight: "auto" },
  icon: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  command: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12 },
  search: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12 },
  input: { flex: 1, color: C.text, fontSize: 14, paddingVertical: 12 },
  list: { flex: 1, marginTop: 16 },
  group: { flexDirection: "row", alignItems: "center", gap: 7, padding: 12, paddingTop: 20 },
  groupName: { color: C.muted, fontSize: 12, flexShrink: 1 },
  item: { padding: 12, borderRadius: 6 },
  name: { color: C.text, fontSize: 14 },
  meta: { color: C.muted, fontSize: 10, marginTop: 3 },
  hint: { color: C.muted, fontSize: 12, padding: 12 },
});
