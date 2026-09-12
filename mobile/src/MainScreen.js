import { useEffect, useRef, useState } from "react";
import {
  View, Text, TextInput, Pressable, FlatList, StyleSheet,
  KeyboardAvoidingView, Platform, StatusBar, SafeAreaView, Alert, Switch,
} from "react-native";
import { C } from "./theme";
import ApprovalCard from "./ApprovalCard";
import SettingsModal from "./SettingsModal";
import SessionsModal from "./SessionsModal";
import DiffModal from "./DiffModal";
import MembershipScreen from "./MembershipScreen";
import WriterConflictModal from "./WriterConflictModal";
import { ensureNotifPermission } from "./useRelay";
import Feather from "@expo/vector-icons/Feather";

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
        <Text selectable style={s.bodyText}>{e.text}</Text>
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
    if (!t || !connected || (running && !steerMode)) return;
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
      <StatusBar barStyle="light-content" />
      <View style={s.root}>
        {/* Header */}
        <View style={s.header}>
          <Pressable accessibilityLabel="打开会话列表" onPress={openSessions} style={s.iconButton}><Feather name="menu" size={22} color={C.text} /></Pressable>
          <Pressable style={s.brand} accessibilityLabel="选择模型和思考等级" onPress={() => { actions.listModels(relayState.cwd); setShowSettings(true); }}>
            <Text style={s.title}>CodexApp</Text>
            <Feather name="chevron-down" size={16} color={C.muted} />
          </Pressable>
          <View style={s.headerRight}>
            <View style={[s.dot, { backgroundColor: connected ? C.accent : C.danger }]} />
            <Text style={s.pillText}>{connLabel}</Text>
            <Pressable accessibilityLabel="新建会话" disabled={!connected || running} onPress={() => actions.newThread()} style={s.iconButton}><Feather name="edit" size={21} color={!connected || running ? C.muted : C.text} /></Pressable>
            <Pressable accessibilityLabel="设置" onPress={() => { actions.listModels(relayState.cwd); setShowSettings(true); }} style={s.iconButton}><Feather name="more-horizontal" size={22} color={C.text} /></Pressable>
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
            contentContainerStyle={{ padding: 20, gap: 20, flexGrow: 1 }}
            inverted={events.length > 0}
            data={events.slice().reverse()}
            keyExtractor={(e, i) => e.id || String(i)}
            renderItem={({ item }) => <EventRow e={item} />}
            initialNumToRender={20}
            ListEmptyComponent={<View style={s.emptyState}><Feather name="message-circle" size={32} color={C.text} /><Text style={s.emptyTitle}>有什么可以帮忙的？</Text></View>}
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
              <Feather name="file-text" size={16} color={C.accent2} /><Text style={s.diffBarText}>查看本次改动</Text>
            </Pressable>
          )}

          {/* Composer */}
          <View style={s.composer}>
            {running && (
              <View style={s.runningBar}>
                <Text style={s.muted}>正在处理</Text>
                <Pressable accessibilityLabel="停止当前任务" style={s.stopBtn} onPress={actions.interrupt}>
                  <Feather name="square" size={16} color={C.bg} />
                </Pressable>
              </View>
            )}
            <View style={s.composerBox}>
              <TextInput
                style={s.input}
                value={text}
                onChangeText={setText}
                placeholder={steerMode ? "补充当前任务" : "发送消息"}
                placeholderTextColor={C.muted}
                multiline
              />
              <View style={s.inputRow}>
                <Pressable style={s.effortButton} accessibilityLabel="选择思考等级" onPress={() => { actions.listModels(relayState.cwd); setShowSettings(true); }}><Feather name="sliders" size={16} color={C.muted} /><Text numberOfLines={1} style={[s.muted, { flexShrink: 1 }]}>{({ low: "低", medium: "中等", high: "高", xhigh: "特高", max: "最高", ultra: "极致", minimal: "极低", none: "关闭思考" })[relayState.reasoningEffort] || relayState.reasoningEffort || "默认思考"}</Text></Pressable>
                <Text style={s.muted}>纠偏</Text><Switch accessibilityLabel="纠偏模式" value={steerMode} onValueChange={setSteerMode} trackColor={{ false: C.line, true: C.accent }} style={{ transform: [{ scale: 0.7 }], marginHorizontal: -6 }} />
                <Pressable accessibilityLabel="发送消息" disabled={!connected || !text.trim() || (running && !steerMode)} style={[s.sendBtn, (!connected || !text.trim() || (running && !steerMode)) && { opacity: 0.35 }]} onPress={send}><Feather name="arrow-up" size={22} color={C.bg} /></Pressable>
              </View>
            </View>
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
          activeThreadId={relayState.threadId}
          onNewThread={() => { if (!connected || running) return; actions.newThread(); setShowSessions(false); }}
          onSettings={() => { setShowSessions(false); actions.listModels(relayState.cwd); setShowSettings(true); }}
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
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8, minHeight: 56 },
  brand: { flexDirection: "row", alignItems: "center", gap: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  title: { color: C.text, fontSize: 17, fontWeight: "600" },
  headerRight: { flexDirection: "row", alignItems: "center", gap: 4, marginLeft: "auto" },
  iconButton: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  pill: { borderRadius: 999, borderWidth: 1, paddingVertical: 4, paddingHorizontal: 10 },
  pillIdle: { borderColor: C.line },
  pillRun: { backgroundColor: C.accent, borderColor: C.accent },
  pillText: { color: C.muted, fontSize: 12 },
  gear: { color: C.text, fontSize: 22 },
  subbar: { color: C.muted, fontSize: 10, paddingHorizontal: 20, paddingBottom: 8, fontFamily: MONO },
  feed: { flex: 1 },
  sysLine: { color: C.muted, fontSize: 12, textAlign: "center", paddingVertical: 2 },
  bubble: { borderRadius: 8, padding: 10 },
  user: { backgroundColor: C.card2, alignSelf: "flex-end", maxWidth: "86%", borderRadius: 22, paddingHorizontal: 16 },
  userText: { color: C.text },
  assistant: { backgroundColor: "transparent", padding: 0 },
  label: { color: C.muted, fontSize: 11, marginBottom: 3 },
  bodyText: { color: C.text, lineHeight: 25 },
  cmd: { backgroundColor: C.bg2, borderColor: C.line, borderWidth: 1 },
  tool: { backgroundColor: C.bg2, borderColor: C.line, borderWidth: 1 },
  error: { backgroundColor: C.card, borderColor: C.danger, borderWidth: 1 },
  errorText: { color: C.danger },
  approvals: { paddingHorizontal: 12, paddingTop: 8 },
  diffBar: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginBottom: 8, padding: 10, borderRadius: 6, borderWidth: 1, borderColor: C.line, backgroundColor: C.bg2 },
  diffBarText: { color: C.accent2, fontWeight: "700", fontSize: 14 },
  composer: { padding: 16, paddingTop: 8, paddingBottom: Platform.OS === "ios" ? 18 : 10 },
  composerBox: { borderWidth: 1, borderColor: C.line, borderRadius: 26, padding: 12 },
  effortButton: { flexDirection: "row", alignItems: "center", gap: 6, marginRight: "auto", maxWidth: "42%" },
  emptyState: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  emptyTitle: { color: C.text, fontSize: 22, fontWeight: "600" },
  runningBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingBottom: 6 },
  muted: { color: C.muted, fontSize: 13 },
  stopBtn: { backgroundColor: C.text, borderRadius: 16, width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  stopText: { color: C.danger, fontWeight: "700" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  input: { backgroundColor: "transparent", color: C.text, paddingHorizontal: 4, paddingBottom: 12, fontSize: 16, minHeight: 40, maxHeight: 160 },
  sendBtn: { backgroundColor: C.text, borderRadius: 18, width: 36, height: 36, alignItems: "center", justifyContent: "center", marginLeft: "auto" },
  sendText: { color: "#042", fontWeight: "800", fontSize: 15 },
  steerToggle: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  checkbox: { width: 18, height: 18, borderRadius: 4, borderColor: C.line, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  checkboxOn: { backgroundColor: C.accent2, borderColor: C.accent2 },
  check: { color: "#021", fontSize: 12, fontWeight: "900" },
});
