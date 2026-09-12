import { useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, StatusBar, SafeAreaView, Alert,
} from "react-native";
import { C } from "./theme";
import ApprovalCard from "./ApprovalCard";
import SettingsModal from "./SettingsModal";
import SessionsModal from "./SessionsModal";
import DiffModal from "./DiffModal";
import MembershipScreen from "./MembershipScreen";
import WriterConflictModal from "./WriterConflictModal";
import { ensureNotifPermission } from "./useRelay";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

function EventRow({ e }) {
  const k = e.kind || "";
  if (k === "thread" || k === "turn" || k === "approval-requested" || k === "approval-resolved") {
    return <Text style={s.sysLine}>{e.text}</Text>;
  }
  if (k === "user") {
    return (
      <View style={[s.bubble, s.user]}>
        <Text style={s.userText}>{e.text}</Text>
      </View>
    );
  }
  if (k === "error") {
    return (
      <View style={[s.bubble, s.error]}>
        <Text style={s.errorText}>{e.text}</Text>
      </View>
    );
  }
  if (k === "item:agentMessage") {
    return (
      <View style={[s.bubble, s.assistant]}>
        <Text style={s.label}>CODEX</Text>
        <Text style={s.bodyText}>{e.text}</Text>
      </View>
    );
  }
  if (k.startsWith("item:commandExecution")) {
    return (
      <View style={[s.bubble, s.cmd]}>
        <Text style={[s.bodyText, { fontFamily: MONO, fontSize: 13 }]}>{e.text}</Text>
      </View>
    );
  }
  // fileChange / tool / others
  return (
    <View style={[s.bubble, s.tool]}>
      <Text style={[s.bodyText, { fontSize: 14 }]}>{e.text}</Text>
    </View>
  );
}

export default function MainScreen({ relay, onForget }) {
  const { conn, connected, cloud, agentFp, relayState, config, events, approvals, diff, tree, actions } = relay;
  const [text, setText] = useState("");
  const [steerMode, setSteerMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [showRedeem, setShowRedeem] = useState(false);
  const pendingText = useRef(null);
  useEffect(() => {
    const pending = pendingText.current;
    if (pending && events.some((e) => e.kind === "user" && e.text === pending.text && !pending.ids.has(e.id))) {
      const accepted = pending.text;
      pendingText.current = null;
      setText((current) => current.trim() === accepted ? "" : current);
    }
  }, [events]);

  const openSessions = () => { actions.listThreads(); setShowSessions(true); };

  const running = relayState.status === "running";

  const connLabel =
    conn === "unauthorized" ? "账号/密码无效" :
    conn === "needCode" ? "需要配对码" :
    conn === "pairFailed" ? "配对失败" :
    conn === "open" ? (connected ? (running ? "运行中" : "空闲") : (cloud ? (agentFp ? "配对/连接中…" : "等待电脑 Agent") : "中继已连，等待 Codex")) :
    conn === "connecting" ? "连接中…" : "已断开";

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (steerMode) actions.steer(t);
    else if (!actions.prompt(t)) return;
    if (relayState.readOnly) pendingText.current = { text: t, ids: new Set(events.map((e) => e.id)) };
    else setText("");
  };

  const enableNotif = async () => {
    const ok = await ensureNotifPermission();
    Alert.alert(ok ? "通知已开启" : "通知未开启", ok ? "审批到达时会震动并弹通知。" : "请在系统设置里允许通知。");
  };

  const forget = () => {
    setShowSettings(false);
    onForget();
  };

  return (
    <SafeAreaView style={s.safe}>
      <View style={s.root}>
        {/* Header */}
        <View style={s.header}>
          <View style={s.brand}>
            <View style={[s.dot, { backgroundColor: connected ? C.accent : C.danger }]} />
            <Text style={s.title}>CodexApp</Text>
          </View>
          <View style={s.headerRight}>
            <View style={[s.pill, running ? s.pillRun : s.pillIdle]}>
              <Text style={[s.pillText, running && { color: "#042", fontWeight: "700" }]}>{connLabel}</Text>
            </View>
            <Pressable onPress={openSessions} hitSlop={10}>
              <Text style={s.gear}>📂</Text>
            </Pressable>
            <Pressable onPress={() => { actions.listModels(relayState.cwd); setShowSettings(true); }} hitSlop={10}>
              <Text style={s.gear}>⚙</Text>
            </Pressable>
          </View>
        </View>
        <Text style={s.subbar} numberOfLines={1}>
          {(relayState.threadName ? "「" + relayState.threadName + "」 " : "") +
            (relayState.cwd || "—") + ((relayState.effectiveModel || relayState.model) ? "  ·  " + (relayState.effectiveModel || relayState.model) : "") + "  ·  " + (relayState.approvalPolicy || "") +
            (cloud && agentFp ? "  ·  🔒" + agentFp : "")}
        </Text>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
        >
          {/* Feed */}
          <FlatList
            key={relayState.threadId || "new"}
            style={s.feed}
            contentContainerStyle={{ padding: 12, gap: 8 }}
            inverted
            data={events.slice().reverse()}
            keyExtractor={(e, i) => e.id || String(i)}
            renderItem={({ item }) => <EventRow e={item} />}
            initialNumToRender={20}
          />

          {/* Approvals */}
          {approvals.length > 0 && (
            <View style={s.approvals}>
              {approvals.map((a) => (
                <ApprovalCard key={a.key} approval={a} onDecide={actions.approve} />
              ))}
            </View>
          )}

          {/* Diff bar */}
          {!!diff && (
            <Pressable style={s.diffBar} onPress={() => setShowDiff(true)}>
              <Text style={s.diffBarText}>📝 查看本次改动 (diff)</Text>
            </Pressable>
          )}

          {/* Composer */}
          <View style={s.composer}>
            {running && (
              <View style={s.runningBar}>
                <Text style={s.muted}>任务进行中…</Text>
                <Pressable style={s.stopBtn} onPress={actions.interrupt}>
                  <Text style={s.stopText}>停止</Text>
                </Pressable>
              </View>
            )}
            <View style={s.inputRow}>
              <TextInput
                style={s.input}
                value={text}
                onChangeText={setText}
                placeholder={steerMode ? "纠偏：插话当前任务…" : "输入提示词，控制 Codex…"}
                placeholderTextColor={C.muted}
                multiline
              />
              <Pressable style={s.sendBtn} onPress={send}>
                <Text style={s.sendText}>{steerMode ? "纠偏" : "发送"}</Text>
              </Pressable>
            </View>
            <Pressable style={s.steerToggle} onPress={() => setSteerMode((v) => !v)}>
              <View style={[s.checkbox, steerMode && s.checkboxOn]}>{steerMode && <Text style={s.check}>✓</Text>}</View>
              <Text style={s.muted}>纠偏模式（插话当前任务）</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>

        <SettingsModal
          visible={showSettings}
          config={{ ...config, cwd: config.cwd || relayState.cwd }}
          models={relay.models}
          onRefreshModels={actions.listModels}
          cloud={cloud}
          membershipUntil={relay.membershipUntil}
          onRedeem={() => { setShowSettings(false); setShowRedeem(true); }}
          onApply={async (cfg) => { await actions.applyConfig(cfg); setShowSettings(false); }}
          onNewThread={async (cfg) => { await actions.applyConfig(cfg); actions.newThread(cfg.cwd); setShowSettings(false); }}
          onEnableNotif={enableNotif}
          onForget={forget}
          onClose={() => setShowSettings(false)}
        />
        {showRedeem && <MembershipScreen relay={relay} onClose={() => setShowRedeem(false)} />}

        <SessionsModal
          visible={showSessions}
          tree={tree}
          onResume={(id) => { actions.readThread(id); setShowSessions(false); }}
          onRefresh={() => actions.listThreads()}
          onClose={() => setShowSessions(false)}
        />
        <DiffModal visible={showDiff} diff={diff} onClose={() => setShowDiff(false)} />
        <WriterConflictModal conflict={relay.writerConflict} busy={relay.writerBusy} error={relay.writerError} onRetry={actions.retryWriter} onInspect={actions.inspectWriter} onTakeover={actions.takeoverWriter} onClose={actions.dismissWriter} />
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.bg, paddingTop: Platform.OS === "android" ? StatusBar.currentHeight : 0 },
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingTop: 10, paddingBottom: 8, borderBottomColor: C.line, borderBottomWidth: 1 },
  brand: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  title: { color: C.text, fontSize: 18, fontWeight: "700" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  pill: { borderRadius: 999, borderWidth: 1, paddingVertical: 4, paddingHorizontal: 10 },
  pillIdle: { borderColor: C.line },
  pillRun: { backgroundColor: C.accent, borderColor: C.accent },
  pillText: { color: C.muted, fontSize: 12 },
  gear: { color: C.text, fontSize: 22 },
  subbar: { color: C.muted, fontSize: 12, paddingHorizontal: 14, paddingVertical: 6, borderBottomColor: C.line, borderBottomWidth: 1, fontFamily: MONO },
  feed: { flex: 1 },
  sysLine: { color: C.muted, fontSize: 12, textAlign: "center", paddingVertical: 2 },
  bubble: { borderRadius: 12, padding: 10 },
  user: { backgroundColor: C.card2, alignSelf: "flex-end", maxWidth: "88%" },
  userText: { color: C.text },
  assistant: { backgroundColor: C.card },
  label: { color: C.muted, fontSize: 11, marginBottom: 3, letterSpacing: 0.5 },
  bodyText: { color: C.text, lineHeight: 20 },
  cmd: { backgroundColor: "#0d1526", borderColor: C.line, borderWidth: 1 },
  tool: { backgroundColor: "#101c33", borderColor: C.line, borderWidth: 1 },
  error: { backgroundColor: "#2a1620", borderColor: C.danger, borderWidth: 1 },
  errorText: { color: C.danger },
  approvals: { paddingHorizontal: 12, paddingTop: 8 },
  diffBar: { marginHorizontal: 12, marginBottom: 8, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: C.accent2, backgroundColor: "#0d1c33" },
  diffBarText: { color: C.accent2, fontWeight: "700", fontSize: 14 },
  composer: { borderTopColor: C.line, borderTopWidth: 1, padding: 10, paddingBottom: Platform.OS === "ios" ? 18 : 10 },
  runningBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 6 },
  muted: { color: C.muted, fontSize: 13 },
  stopBtn: { borderColor: C.danger, borderWidth: 1, borderRadius: 8, paddingVertical: 6, paddingHorizontal: 14 },
  stopText: { color: C.danger, fontWeight: "700" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: { flex: 1, backgroundColor: C.bg2, color: C.text, borderColor: C.line, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, maxHeight: 120 },
  sendBtn: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  sendText: { color: "#042", fontWeight: "800", fontSize: 15 },
  steerToggle: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderColor: C.line, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: C.accent2, borderColor: C.accent2 },
  check: { color: "#021", fontSize: 12, fontWeight: "900" },
});
