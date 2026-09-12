import { useState } from "react";
import { View, Text, TextInput, Pressable, StyleSheet, KeyboardAvoidingView, Platform, ScrollView } from "react-native";
import { C } from "./theme";
import { BROKER_URL } from "./config";

export default function SetupScreen({ initial, onConnect }) {
  const [mode, setMode] = useState(initial?.mode || "cloud");
  const [reg, setReg] = useState(false);          // cloud: false=login, true=register
  const [email, setEmail] = useState(initial?.email || "");
  const [password, setPassword] = useState(initial?.password || "");
  const [pass2, setPass2] = useState("");
  const [url, setUrl] = useState(initial?.url || "");
  const [token, setToken] = useState(initial?.token || "");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const broker = () => BROKER_URL; // cloud broker is fixed

  const login = () => {
    if (!broker() || !email.trim() || !password) { setMsg("请填 Broker、邮箱、密码"); return; }
    onConnect({ mode: "cloud", brokerUrl: broker(), email: email.trim(), password });
  };
  const connectLan = () => {
    if (!url.trim() || !token.trim()) return;
    onConnect({ mode: "lan", url: url.trim(), token: token.trim() });
  };
  const doRegister = async () => {
    if (!broker() || !email.trim() || !password) { setMsg("请填 Broker、邮箱、密码"); return; }
    if (password.length < 8) { setMsg("密码至少 8 位"); return; }
    if (password !== pass2) { setMsg("两次密码不一致"); return; }
    setBusy(true); setMsg("注册中…");
    try {
      const r = await fetch(broker() + "/api/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim(), password }) });
      const j = await r.json().catch(() => ({}));
      setBusy(false);
      if (r.status === 409) { setMsg("账号已存在，请返回登录。"); return; }
      if (!r.ok) { setMsg("注册失败：" + (j.error || r.status)); return; }
      setMsg(j.emailSent ? "✅ 验证邮件已发送，查收点链接验证后返回登录。" : "账号已创建。未配 SMTP：验证链接在服务器日志里。");
    } catch (e) { setBusy(false); setMsg("网络错误：" + e.message); }
  };
  const doForgot = async () => {
    if (!broker() || !email.trim()) { setMsg("请先填 Broker 和邮箱"); return; }
    try { await fetch(broker() + "/api/forgot-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: email.trim() }) }); } catch {}
    setMsg("若该邮箱已注册，重置链接已发送，请查收邮件。");
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={s.wrap}>
      <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled">
        <View style={s.card}>
          <Text style={s.h1}>CodexApp</Text>
          <Text style={s.sub}>远程控制电脑上的 Codex</Text>

          <View style={s.tabs}>
            <Pressable style={[s.tab, mode === "cloud" && s.tabOn]} onPress={() => { setMode("cloud"); setMsg(""); }}>
              <Text style={[s.tabText, mode === "cloud" && s.tabTextOn]}>云账号（随处可用）</Text>
            </Pressable>
            <Pressable style={[s.tab, mode === "lan" && s.tabOn]} onPress={() => { setMode("lan"); setMsg(""); }}>
              <Text style={[s.tabText, mode === "lan" && s.tabTextOn]}>中继直连</Text>
            </Pressable>
          </View>

          {mode === "cloud" ? (
            <>
              <Text style={s.label}>账号邮箱</Text>
              <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" />
              <Text style={s.label}>密码</Text>
              <TextInput style={s.input} value={password} onChangeText={setPassword} placeholder={reg ? "至少 8 位" : "账号密码"} placeholderTextColor={C.muted} secureTextEntry />

              {reg ? (
                <>
                  <Text style={s.label}>确认密码</Text>
                  <TextInput style={s.input} value={pass2} onChangeText={setPass2} placeholder="再输入一次" placeholderTextColor={C.muted} secureTextEntry />
                  <Pressable style={[s.btn, busy && { opacity: 0.6 }]} disabled={busy} onPress={doRegister}><Text style={s.btnText}>注册</Text></Pressable>
                  <Pressable style={s.ghost} onPress={() => { setReg(false); setMsg(""); }}><Text style={s.ghostText}>返回登录</Text></Pressable>
                </>
              ) : (
                <>
                  <Pressable style={s.btn} onPress={login}><Text style={s.btnText}>登录</Text></Pressable>
                  <Pressable style={s.btn2} onPress={() => { setReg(true); setMsg(""); }}><Text style={s.btn2Text}>注册新账号</Text></Pressable>
                  <Pressable style={s.ghost} onPress={doForgot}><Text style={s.ghostText}>忘记密码？</Text></Pressable>
                  <Text style={s.hint}>登录后，电脑端登录同一账号即可配对。内容端到端加密，服务器看不到。</Text>
                </>
              )}
              {!!msg && <Text style={s.msg}>{msg}</Text>}
            </>
          ) : (
            <>
              <Text style={s.label}>中继地址</Text>
              <TextInput style={s.input} value={url} onChangeText={setUrl} placeholder="http://192.168.x.x:4123" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} keyboardType="url" />
              <Text style={s.label}>访问 Token</Text>
              <TextInput style={s.input} value={token} onChangeText={setToken} placeholder="粘贴电脑终端显示的 Token" placeholderTextColor={C.muted} autoCapitalize="none" autoCorrect={false} />
              <Pressable style={s.btn} onPress={connectLan}><Text style={s.btnText}>连接</Text></Pressable>
              <Text style={s.hint}>同一 WiFi 直连，电脑跑 npm start 会打印地址和 Token。</Text>
            </>
          )}
          <Text style={s.security}>🔒 安全说明：全程端到端加密。服务器只转发加密数据，看不到你的账号内容、Codex 对话、代码与命令。</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, justifyContent: "center", padding: 22 },
  card: { backgroundColor: C.card, borderColor: C.line, borderWidth: 1, borderRadius: 18, padding: 22 },
  h1: { color: C.text, fontSize: 30, fontWeight: "800" },
  sub: { color: C.muted, marginTop: 4, marginBottom: 14 },
  tabs: { flexDirection: "row", backgroundColor: C.bg2, borderRadius: 10, padding: 4, marginBottom: 6 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: "center" },
  tabOn: { backgroundColor: C.card2 },
  tabText: { color: C.muted, fontSize: 13, fontWeight: "600" },
  tabTextOn: { color: C.text },
  label: { color: C.muted, fontSize: 13, marginTop: 12, marginBottom: 4 },
  input: { backgroundColor: C.bg2, color: C.text, borderColor: C.line, borderWidth: 1, borderRadius: 10, padding: 13, fontSize: 16 },
  hint: { color: C.muted, fontSize: 12, marginTop: 12 },
  security: { color: C.muted, fontSize: 12, marginTop: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: C.line, lineHeight: 18 },
  msg: { color: C.muted, fontSize: 13, marginTop: 12 },
  btn: { backgroundColor: C.accent, borderRadius: 12, padding: 15, alignItems: "center", marginTop: 16 },
  btnText: { color: "#042", fontWeight: "800", fontSize: 17 },
  btn2: { backgroundColor: C.card2, borderRadius: 12, padding: 14, alignItems: "center", marginTop: 10 },
  btn2Text: { color: C.text, fontWeight: "700", fontSize: 15 },
  ghost: { padding: 12, alignItems: "center", marginTop: 6 },
  ghostText: { color: C.muted, fontWeight: "600", fontSize: 14 },
});
