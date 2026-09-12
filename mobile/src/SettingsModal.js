import { useEffect, useState } from "react";
import { Modal, View, Text, TextInput, Pressable, ScrollView, StyleSheet } from "react-native";
import { C } from "./theme";
import { fmtMember } from "./membership";

const POLICIES = ["on-request", "untrusted", "on-failure", "never"];
const SANDBOXES = ["workspace-write", "read-only", "danger-full-access"];
const EFFORTS = { none: "关闭思考", minimal: "极低", low: "低", medium: "中等", high: "高", xhigh: "特高", max: "最高", ultra: "极致" };

function Chips({ value, options, onPick }) {
  return (
    <View style={s.chips}>
      {options.map((o) => {
        const on = o === value;
        return (
          <Pressable key={o} onPress={() => onPick(o)} style={[s.chip, on && s.chipOn]}>
            <Text style={[s.chipText, on && s.chipTextOn]}>{o}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function SettingsModal({ visible, config, models, onRefreshModels, cloud, membershipUntil, onRedeem, onApply, onNewThread, onEnableNotif, onForget, onClose }) {
  const [cwd, setCwd] = useState("");
  const [policy, setPolicy] = useState("on-request");
  const [sandbox, setSandbox] = useState("workspace-write");
  const [model, setModel] = useState("default");
  const [customModel, setCustomModel] = useState("");
  const [modelMenu, setModelMenu] = useState(false);
  const [effort, setEffort] = useState("");
  const [effortMenu, setEffortMenu] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (visible) {
      setCwd(config.cwd || "");
      setPolicy(config.approvalPolicy || "on-request");
      setSandbox(config.sandbox || "workspace-write");
      setModel(config.model ? (models.models.some((m) => m.model === config.model) ? "model:" + config.model : "custom") : "default");
      setCustomModel(config.model || "");
      setEffort(config.reasoningEffort || ""); setEffortMenu(false);
      setModelMenu(false); setSaving(false); setError("");
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const options = [
    { value: "default", label: models.defaultModel ? "Codex 默认（" + models.defaultModel + "）" : "Codex 默认" },
    ...models.models.map((m) => ({ value: "model:" + m.model, label: m.displayName === m.model ? m.model : m.displayName + " · " + m.model })),
    { value: "custom", label: "自定义模型" },
  ];
  const submit = async (create) => {
    if (saving) return;
    const selected = model === "default" ? null : model === "custom" ? customModel.trim() : model.slice(6);
    if (model === "custom" && (!selected || /\s|[\x00-\x1f\x7f]/.test(selected))) { setError("请输入有效的模型 ID"); return; }
    setSaving(true); setError("");
    try {
      if (effort && !/^[a-z][a-z0-9_-]{0,63}$/.test(effort)) throw new Error("无效的思考等级");
      await (create ? onNewThread : onApply)({ cwd: cwd.trim() || undefined, approvalPolicy: policy, sandbox, model: selected, reasoningEffort: effort || null });
    } catch (e) { setError(e.message || String(e)); }
    finally { setSaving(false); }
  };

  const modelId = model === "default" ? models.defaultModel : model === "custom" ? customModel.trim() : model.slice(6);
  useEffect(() => {
    if (model === "custom" && models.models.some((m) => m.model === customModel.trim())) setModel("model:" + customModel.trim());
  }, [model, customModel, models.models]);
  const entry = models.models.find((m) => m.model === modelId);
  const knownEfforts = Array.isArray(entry?.supportedReasoningEfforts);
  const levels = knownEfforts ? entry.supportedReasoningEfforts.map((o) => o.reasoningEffort) : Object.keys(EFFORTS);
  const defaultEffort = (model === "default" ? models.defaultReasoningEffort : null) || entry?.defaultReasoningEffort;
  const effortOptions = [{ value: "", label: defaultEffort ? "Codex 默认（" + (EFFORTS[defaultEffort] || defaultEffort) + "）" : "Codex 默认" }, ...levels.map((value) => ({ value, label: EFFORTS[value] || value }))];
  useEffect(() => { if (knownEfforts && effort && !levels.includes(effort)) setEffort(""); }, [modelId, models.models]);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={s.backdrop}>
        <View style={s.sheet}>
          <ScrollView>
            <Text style={s.h2}>设置</Text>

            <Text style={s.label}>工作目录 (cwd)</Text>
            <TextInput style={s.input} value={cwd} onChangeText={setCwd} autoCapitalize="none" autoCorrect={false} placeholder="C:\\test" placeholderTextColor={C.muted} />

            <Text style={s.label}>模型</Text>
            <View style={s.modelRow}>
              <Pressable accessibilityRole="button" accessibilityLabel="选择模型" accessibilityState={{ expanded: modelMenu }} style={[s.input, s.modelSelect]} onPress={() => setModelMenu((v) => !v)}>
                <Text style={s.modelText} numberOfLines={1}>{options.find((o) => o.value === model)?.label || model.slice(6)}</Text>
                <Text style={s.modelText}>⌄</Text>
              </Pressable>
              <Pressable accessibilityRole="button" disabled={models.loading} onPress={() => onRefreshModels(cwd.trim() || undefined)} style={s.refresh}>
                <Text style={{ color: models.loading ? C.muted : C.accent2 }}>刷新</Text>
              </Pressable>
            </View>
            {modelMenu && (
              <ScrollView style={s.modelMenu} nestedScrollEnabled>
                {options.map((o) => (
                  <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: model === o.value }} onPress={() => { setModel(o.value); setModelMenu(false); setError(""); }} style={s.modelOption}>
                    <Text style={{ color: model === o.value ? C.accent : C.muted }}>{model === o.value ? "●" : "○"}</Text>
                    <Text style={[s.modelText, { flex: 1 }]}>{o.label}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            )}
            {model === "custom" && (
              <>
                <Text style={s.label}>模型 ID</Text>
                <TextInput accessibilityLabel="模型 ID" style={s.input} value={customModel} onChangeText={(value) => { setCustomModel(value); setError(""); }} maxLength={200} autoCapitalize="none" autoCorrect={false} />
              </>
            )}
            {!!(models.loading || models.error || !models.models.length) && <Text style={s.label}>{models.loading ? "加载中…" : models.error ? "模型列表加载不完整：" + models.error : "暂无可选模型"}</Text>}

            <Text style={s.label}>思考等级</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="选择思考等级" accessibilityState={{ expanded: effortMenu }} style={[s.input, s.modelSelect]} onPress={() => setEffortMenu((v) => !v)}>
              <Text style={s.modelText}>{effortOptions.find((o) => o.value === effort)?.label || effort}</Text>
            </Pressable>
            {effortMenu && <ScrollView style={s.modelMenu} nestedScrollEnabled>{effortOptions.map((o) => <Pressable key={o.value} accessibilityRole="radio" accessibilityState={{ checked: effort === o.value }} style={s.modelOption} onPress={() => { setEffort(o.value); setEffortMenu(false); }}><Text style={[s.modelText, { color: effort === o.value ? C.accent : C.text }]}>{o.label}</Text></Pressable>)}</ScrollView>}
            {!knownEfforts && <TextInput accessibilityLabel="自定义思考等级" style={[s.input, { marginTop: 6 }]} value={effort} onChangeText={setEffort} maxLength={64} autoCapitalize="none" autoCorrect={false} placeholder="自定义等级" placeholderTextColor={C.muted} />}

            <Text style={s.label}>审批策略</Text>
            <Chips value={policy} options={POLICIES} onPick={setPolicy} />

            <Text style={s.label}>沙箱</Text>
            <Chips value={sandbox} options={SANDBOXES} onPick={setSandbox} />

            <View style={s.row}>
              <Pressable disabled={saving} style={[s.btn, s.primary, saving && { opacity: 0.5 }]} onPress={() => submit(false)}>
                <Text style={[s.btnText, { color: "#042" }]}>{saving ? "保存中…" : "应用"}</Text>
              </Pressable>
              <Pressable disabled={saving} style={[s.btn, s.secondary]} onPress={() => submit(true)}>
                <Text style={s.btnText}>新建会话</Text>
              </Pressable>
            </View>

            {!!error && <Text accessibilityRole="alert" style={[s.label, { color: C.danger }]}>{error}</Text>}
            <Pressable style={[s.btn, s.secondary, s.full]} onPress={onEnableNotif}>
              <Text style={s.btnText}>开启审批通知</Text>
            </Pressable>
            {cloud && (
              <>
                <Text style={[s.label, { marginTop: 16 }]}>会员：{fmtMember(membershipUntil)}（局域网模式免费）</Text>
                <Pressable style={[s.btn, s.secondary, s.full]} onPress={onRedeem}>
                  <Text style={s.btnText}>兑换 / 续费会员</Text>
                </Pressable>
              </>
            )}
            <Pressable style={[s.btn, s.ghost, s.full]} onPress={onForget}>
              <Text style={[s.btnText, { color: C.danger }]}>退出 / 忘记连接</Text>
            </Pressable>
            <Pressable style={[s.btn, s.ghost, s.full]} onPress={onClose}>
              <Text style={[s.btnText, { color: C.muted }]}>关闭</Text>
            </Pressable>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  sheet: { backgroundColor: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 18, maxHeight: "86%" },
  h2: { color: C.text, fontSize: 20, fontWeight: "800", marginBottom: 6 },
  label: { color: C.muted, fontSize: 13, marginTop: 12, marginBottom: 6 },
  input: { backgroundColor: C.bg2, color: C.text, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15 },
  modelRow: { flexDirection: "row", gap: 8, alignItems: "center" },
  modelSelect: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8, minHeight: 48, borderRadius: 8 },
  modelText: { color: C.text, fontSize: 15, flexShrink: 1 },
  refresh: { minWidth: 48, minHeight: 48, justifyContent: "center", alignItems: "center" },
  modelMenu: { maxHeight: 220, borderColor: C.line, borderWidth: 1, borderRadius: 8, marginTop: 4, backgroundColor: C.bg2 },
  modelOption: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: C.line },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderColor: C.line, borderWidth: 1, borderRadius: 999, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: C.bg2 },
  chipOn: { backgroundColor: C.accent2, borderColor: C.accent2 },
  chipText: { color: C.muted, fontSize: 13 },
  chipTextOn: { color: "#021", fontWeight: "700" },
  row: { flexDirection: "row", gap: 8, marginTop: 16 },
  btn: { flex: 1, borderRadius: 10, paddingVertical: 13, alignItems: "center", borderWidth: 1, borderColor: C.line },
  primary: { backgroundColor: C.accent, borderColor: C.accent },
  secondary: { backgroundColor: C.card2 },
  ghost: { backgroundColor: "transparent" },
  full: { flex: 0, marginTop: 10 },
  btnText: { color: C.text, fontWeight: "700", fontSize: 15 },
});
