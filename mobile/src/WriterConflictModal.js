import { Modal, View, Text, Pressable, ScrollView, StyleSheet, Alert } from "react-native";
import { C } from "./theme";

export default function WriterConflictModal({ conflict, busy, error, onRetry, onInspect, onTakeover, onClose }) {
  const confirm = (owner) => Alert.alert(
    "确认结束进程 PID " + owner.pid,
    "将影响该进程持有的 " + owner.affectedThreads.length + " 个会话。已产生的文件改动不会回滚，已启动的子进程可能继续运行。",
    [{ text: "取消", style: "cancel" }, { text: "确认结束", style: "destructive", onPress: () => onTakeover(owner.token) }],
  );
  return (
    <Modal visible={!!conflict} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <Text style={s.h2}>会话被占用</Text>
          <ScrollView>
            <Text style={s.body}>{conflict?.message}</Text>
            {(conflict?.owners || []).map((owner) => (
              <View key={owner.pid} style={s.owner}>
                <Text style={s.title}>{owner.name} · PID {owner.pid}</Text>
                {(owner.affectedThreads || []).map((id) => <Text key={id} selectable style={s.id}>{id}</Text>)}
                {owner.canTerminate && owner.token ? (
                  <Pressable disabled={busy} style={s.button} onPress={() => confirm(owner)}><Text style={{ color: C.danger }}>结束进程并尝试接续</Text></Pressable>
                ) : <Text style={s.body}>无法安全结束此进程，请在电脑端关闭对应会话。</Text>}
              </View>
            ))}
            {!!(busy || error) && <Text accessibilityRole="alert" style={[s.body, { color: error ? C.danger : C.muted }]}>{busy ? "处理中…" : error}</Text>}
          </ScrollView>
          <View style={s.row}>
            <Pressable disabled={busy} style={[s.button, s.grow]} onPress={onRetry}><Text style={s.body}>重试接续</Text></Pressable>
            <Pressable disabled={busy} style={[s.button, s.grow]} onPress={onInspect}><Text style={s.body}>重新检查占用</Text></Pressable>
          </View>
          <Pressable disabled={busy} style={s.button} onPress={onClose}><Text style={s.body}>关闭</Text></Pressable>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.card, padding: 18, maxHeight: "86%", borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  h2: { color: C.text, fontSize: 20, fontWeight: "700", marginBottom: 12 },
  body: { color: C.text, fontSize: 14, lineHeight: 21, flexShrink: 1 },
  owner: { paddingVertical: 12, borderBottomColor: C.line, borderBottomWidth: 1 },
  title: { color: C.text, fontWeight: "700", marginBottom: 8 },
  id: { color: C.muted, fontSize: 12, marginVertical: 4 },
  button: { borderWidth: 1, borderColor: C.line, borderRadius: 8, padding: 12, alignItems: "center", marginTop: 10, minHeight: 44 },
  row: { flexDirection: "row", gap: 8 },
  grow: { flex: 1, minWidth: 0 },
});
