// Core connection hook. Two transports, same downstream handling:
//   - LAN   : direct WebSocket to the relay (url + token).
//   - Cloud : login to the broker, connect outbound, END-TO-END encrypted
//             with the PC agent (broker only relays ciphertext).
import { useEffect, useRef, useState, useCallback } from "react";
import { Vibration, Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { seal, open, fingerprint, sas } from "./e2e";


try {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  });
} catch {}

export async function ensureNotifPermission() {
  try {
    const { status } = await Notifications.getPermissionsAsync();
    if (status === "granted") return true;
    return (await Notifications.requestPermissionsAsync()).status === "granted";
  } catch { return false; }
}

const stripSlash = (s) => (s || "").replace(/\/+$/, "");

export function useRelay(profile, keypair) {
  const cloud = profile?.mode === "cloud";
  const [conn, setConn] = useState("connecting"); // connecting|open|unauthorized|closed
  const [relayState, setRelayState] = useState({});
  const [models, setModels] = useState({ models: [], defaultModel: null, loading: false, error: "" });
  const [writerConflict, setWriterConflict] = useState(null);
  const [writerBusy, setWriterBusy] = useState(false);
  const [writerError, setWriterError] = useState("");
  const [config, setConfig] = useState({ approvalPolicy: "on-request", sandbox: "workspace-write", cwd: "" });
  const [events, setEvents] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [diff, setDiff] = useState("");
  const [tree, setTree] = useState({ projects: [], projectless: [] });
  const [agentFp, setAgentFp] = useState(null);
  const [paired, setPaired] = useState(false);
  const [pairError, setPairError] = useState("");
  const [agents, setAgents] = useState([]), [agentId, setAgentId] = useState(null);
  const [selectedTarget, setSelectedTarget] = useState(null);
  const selectedAgentRef = useRef(null), authRef = useRef(null), generationRef = useRef(0);

  const wsRef = useRef(null);
  const configRequests = useRef(new Map());
  const modelsTimer = useRef(null);
  const writerRequest = useRef(null);
  const writerTimer = useRef(null);
  const backoffRef = useRef(1000);
  const timerRef = useRef(null);
  const aliveRef = useRef(true);
  const agentPubRef = useRef(null);
  const authBlockedRef = useRef(false);

  const notifyApproval = useCallback((a) => {
    try { Vibration.vibrate(Platform.OS === "android" ? [0, 80, 40, 80] : [80, 40, 80]); } catch {}
    (async () => {
      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== "granted") return;
        await Notifications.scheduleNotificationAsync({ content: { title: "Codex 需要审批：" + (a.title || ""), body: (a.command || "").slice(0, 140) }, trigger: null });
      } catch {}
    })();
  }, []);

  const pushEvents = useCallback((updater) => {
    setEvents(updater);
  }, []);

  // Handle a decrypted/plain CodexApp message (identical for both transports).
  const handle = useCallback((m) => {
    switch (m.type) {
      case "hello":
        clearTimeout(writerTimer.current); writerRequest.current = null;
        setWriterConflict(null); setWriterBusy(false); setWriterError("");
        setRelayState(m.state || {});
        if (m.config) setConfig((c) => ({ ...c, ...m.config, model: m.state?.model ?? null, reasoningEffort: m.state?.reasoningEffort ?? null }));
        setEvents((m.recentEvents || []).map((e) => ({ ...e })));
        setApprovals(m.pendingApprovals || []);
        setDiff(m.diff || "");
        break;
      case "state":
        setRelayState(m.state || {});
        if (m.state) setConfig((c) => ({ ...c, cwd: m.state.cwd, approvalPolicy: m.state.approvalPolicy, sandbox: m.state.sandbox, model: m.state.model ?? null, reasoningEffort: m.state.reasoningEffort ?? null }));
        break;
      case "models":
        clearTimeout(modelsTimer.current);
        setModels({ models: m.models || [], defaultModel: m.defaultModel || null, defaultReasoningEffort: m.defaultReasoningEffort || null, loading: false, error: m.error || "" });
        break;
      case "writerConflict":
        clearTimeout(writerTimer.current); writerRequest.current = null;
        setWriterConflict(m); setWriterBusy(false); setWriterError("");
        break;
      case "configSaved": {
        const pending = configRequests.current.get(m.requestId);
        if (pending) { clearTimeout(pending.timer); configRequests.current.delete(m.requestId); pending.resolve(); }
        break;
      }
      case "diff": setDiff(m.diff || ""); break;
      case "projectTree": setTree({ projects: m.projects || [], projectless: m.projectless || [] }); break;
      case "event":
        pushEvents((prev) => {
          const existing = prev.findIndex((e) => e.id === m.event.id);
          if (existing >= 0) { const c = prev.slice(); c[existing] = m.event; return c; }
          if (m.event.kind === "item:agentMessage") {
            const i = prev.findIndex((e) => e.live && (!m.event.itemId || e.itemId === m.event.itemId));
            if (i >= 0) { const c = prev.slice(); c[i] = { ...m.event, live: false }; return c; }
          }
          return [...prev, m.event];
        });
        break;
      case "assistantDelta":
        pushEvents((prev) => {
          const i = prev.findIndex((e) => e.live && (!m.itemId || e.itemId === m.itemId));
          if (i >= 0) { const c = prev.slice(); c[i] = { ...c[i], text: (c[i].text || "") + m.text }; return c; }
          return [...prev, { id: "live-" + (m.itemId || Date.now()), itemId: m.itemId, ts: Date.now(), kind: "item:agentMessage", text: m.text, live: true }];
        });
        break;
      case "approval":
        setApprovals((prev) => (prev.some((x) => x.key === m.approval.key) ? prev : [m.approval, ...prev]));
        notifyApproval(m.approval);
        break;
      case "approvalResolved": setApprovals((prev) => prev.filter((x) => x.key !== m.key)); break;
      case "error": {
        if (writerRequest.current && writerRequest.current === m.requestId) {
          clearTimeout(writerTimer.current); writerRequest.current = null;
          setWriterBusy(false); setWriterError(m.message);
        }
        const pending = configRequests.current.get(m.requestId);
        if (pending) { clearTimeout(pending.timer); configRequests.current.delete(m.requestId); pending.reject(new Error(m.message)); }
        pushEvents((prev) => [...prev, { id: "err-" + Date.now(), ts: Date.now(), kind: "error", text: m.message }]);
        break;
      }
    }
  }, [notifyApproval, pushEvents]);

  const scheduleReconnect = useCallback((connectFn) => {
    if (!aliveRef.current || authBlockedRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { if (aliveRef.current) connectFn(); }, backoffRef.current);
    backoffRef.current = Math.min(backoffRef.current * 1.6, 15000);
  }, []);

  const connect = useCallback(async () => {
    if (!profile || authBlockedRef.current) return;
    const generation = ++generationRef.current;
    const previous = wsRef.current; wsRef.current = null;
    try { previous?.close(); } catch {}
    setConn("connecting");
    agentPubRef.current = null; setAgentFp(null);
    let ws;
    try {
      if (cloud) {
        const authKey = JSON.stringify([profile.brokerUrl, profile.email, profile.password]);
        let token = authRef.current?.key === authKey ? authRef.current.token : null;
        if (!token) {
          const res = await fetch(stripSlash(profile.brokerUrl) + "/api/login", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ email: profile.email, password: profile.password }),
          });
          if (generation !== generationRef.current || !aliveRef.current) return;
          if (res.status === 429) { authBlockedRef.current = true; setConn("rateLimited"); return; }
          if (res.status === 401) { authBlockedRef.current = true; setConn("unauthorized"); return; }
          if (res.status === 403) {
            const reason = await res.json().catch(() => ({}));
            if (generation !== generationRef.current || !aliveRef.current) return;
            authBlockedRef.current = true;
            setConn(reason.code === "account_disabled" ? "disabled" : "unauthorized"); return;
          }
          if (!res.ok) { scheduleReconnect(connect); return; }
          const data = await res.json();
          if (generation !== generationRef.current || !aliveRef.current) return;
          token = data.token; authRef.current = { key: authKey, token };
        }
        ws = new WebSocket(stripSlash(profile.brokerUrl).replace(/^http/, "ws") + "/link");
        ws.onopen = () => { backoffRef.current = 1000; ws.send(JSON.stringify({ type: "auth", token, role: "phone", pubkey: keypair.publicKey, multiAgent: true, agentId: selectedAgentRef.current })); };
      } else {
        ws = new WebSocket(stripSlash(profile.url).replace(/^http/, "ws") + "/ws?token=" + encodeURIComponent(profile.token));
        ws.onopen = () => { backoffRef.current = 1000; setConn("open"); };
      }
    } catch { if (generation === generationRef.current && aliveRef.current) scheduleReconnect(connect); return; }

    wsRef.current = ws;
    ws.onmessage = (ev) => {
      if (authBlockedRef.current || !aliveRef.current || wsRef.current !== ws) return;
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (cloud) {
        if ((m.type === "authed" && m.multiAgent) || m.type === "agents") {
          setAgents(m.agents || []); selectedAgentRef.current = m.agentId || null; setAgentId(m.agentId || null);
          if (m.type === "agents") return;
        }
        if (m.type === "authed") { setConn("open"); if (m.peerOnline && m.peerPubkey) { agentPubRef.current = m.peerPubkey; setAgentFp(fingerprint(m.peerPubkey)); } return; }
        if (m.type === "peer") {
          if (m.agentId && selectedAgentRef.current && m.agentId !== selectedAgentRef.current) return;
          if (m.agentId) { selectedAgentRef.current = m.agentId; setAgentId(m.agentId); }
          agentPubRef.current = m.online ? m.pubkey : null; setAgentFp(m.online ? fingerprint(m.pubkey) : null);
          if (!m.online) { setPaired(false); setRelayState((s) => ({ ...s, codexConnected: false })); }
          return;
        }
        if (m.type === "e2e") {
          if (m.agentId && m.agentId !== selectedAgentRef.current) return;
          const inner = open(m, agentPubRef.current, keypair.secretKey);
          if (!inner) return;
          // Agent online but this device isn't paired -> show the pairing screen (a step AFTER login).
          if (inner.type === "needPairing") { setConn("needPairing"); return; }
          if (inner.type === "paired") {
            if (inner.ok) { setPaired(true); setPairError(""); setConn("open"); }
            else { setPairError(inner.reason || "配对码不对，请重试"); }
            return;
          }
          if (inner.type === "hello") { setPaired(true); setConn("open"); } // already-paired device auto-connects
          handle(inner);
          return;
        }
        if (m.type === "error") {
          if (m.code === "account_disabled" || m.code === "session_revoked" || /token/i.test(m.message || "")) {
            authRef.current = null;
            authBlockedRef.current = true; setPaired(false); setRelayState(s => ({ ...s, codexConnected: false }));
            setConn(m.code === "account_disabled" ? "disabled" : "unauthorized");
            try { ws.close(); } catch {} return;
          }
          return;
        }
        return;
      }
      handle(m);
    };
    ws.onclose = (e) => {
      if (!aliveRef.current || wsRef.current !== ws) return;
      clearTimeout(writerTimer.current);
      if (writerRequest.current) { writerRequest.current = null; setWriterBusy(false); setWriterError("连接已断开，请重新检查占用状态"); }
      clearTimeout(modelsTimer.current);
      setModels((m) => ({ ...m, loading: false }));
      for (const p of configRequests.current.values()) { clearTimeout(p.timer); p.reject(new Error("连接已断开，请重连后检查设置")); }
      configRequests.current.clear();
      if (authBlockedRef.current) return;
      if (e && e.code === 4001) { authBlockedRef.current = true; setConn("unauthorized"); return; }
      setConn("closed"); scheduleReconnect(connect);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }, [profile, keypair, cloud, handle, scheduleReconnect]);

  useEffect(() => {
    aliveRef.current = true;
    setEvents([]); setApprovals([]); setRelayState({}); setDiff(""); setTree({ projects: [], projectless: [] }); setPaired(false); setPairError("");
    setModels({ models: [], defaultModel: null, loading: false, error: "" });
    setWriterConflict(null); setWriterBusy(false); setWriterError("");
    authBlockedRef.current = false;
    connect();
    return () => {
      aliveRef.current = false;
      generationRef.current++;
      clearTimeout(timerRef.current); clearTimeout(modelsTimer.current);
      clearTimeout(writerTimer.current); writerRequest.current = null;
      for (const p of configRequests.current.values()) { clearTimeout(p.timer); p.reject(new Error("连接已关闭")); }
      configRequests.current.clear();
      const previous = wsRef.current; wsRef.current = null;
      try { previous?.close(); } catch {}
    };
  }, [profile, keypair, selectedTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback((obj) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) return false;
    if (cloud) {
      if (!agentPubRef.current) return false;
      ws.send(JSON.stringify({ type: "e2e", ...seal(obj, agentPubRef.current, keypair.secretKey) }));
    } else {
      ws.send(JSON.stringify(obj));
    }
    return true;
  }, [cloud, keypair]);

  const writerAction = (type, extra = {}) => {
    if (!writerConflict || writerRequest.current) return;
    const requestId = "writer-" + Date.now();
    writerRequest.current = requestId; setWriterBusy(true); setWriterError("");
    if (!send({ type, threadId: writerConflict.threadId, requestId, ...extra })) {
      writerRequest.current = null; setWriterBusy(false); setWriterError("连接已断开，操作未发送"); return;
    }
    writerTimer.current = setTimeout(() => {
      writerRequest.current = null; setWriterBusy(false); setWriterError("操作确认超时，请重新检查占用状态");
    }, 30000);
  };

  // Send the pairing SAS for a user-entered code (from the pairing screen).
  const pair = useCallback((code) => {
    const ap = agentPubRef.current, sock = wsRef.current;
    if (!ap || !sock || sock.readyState !== 1) { setPairError("电脑端还没上线，请先在电脑端登录"); return false; }
    sock.send(JSON.stringify({ type: "e2e", ...seal({ type: "pair", tag: sas(code, ap, keypair.publicKey) }, ap, keypair.secretKey) }));
    setPairError("");
    return true;
  }, [keypair]);

  const actions = {
    prompt: (text, cwd) => send({ type: "prompt", text, cwd }),
    steer: (text) => send({ type: "steer", text }),
    interrupt: () => send({ type: "interrupt" }),
    approve: (key, optionId) => { send({ type: "approval", key, optionId }); setApprovals((p) => p.filter((x) => x.key !== key)); },
    newThread: (cwd) => send({ type: "newThread", cwd }),
    applyConfig: (cfg) => new Promise((resolve, reject) => {
      const requestId = "settings-" + Date.now() + "-" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => { configRequests.current.delete(requestId); reject(new Error("保存确认超时，请重连后检查设置")); }, 12000);
      configRequests.current.set(requestId, { resolve, reject, timer });
      if (!send({ type: "setConfig", ...cfg, requestId })) {
        clearTimeout(timer); configRequests.current.delete(requestId); reject(new Error("连接已断开，设置未保存"));
      }
    }),
    listModels: (cwd) => {
      clearTimeout(modelsTimer.current);
      setModels((m) => ({ ...m, loading: true, error: "" }));
      if (!send({ type: "listModels", cwd })) { setModels((m) => ({ ...m, loading: false, error: "连接已断开" })); return; }
      modelsTimer.current = setTimeout(() => setModels((m) => ({ ...m, loading: false, error: "模型列表加载超时" })), 20000);
    },
    listThreads: () => send({ type: "listThreads" }),
    resumeThread: (threadId) => send({ type: "resumeThread", threadId }),
    readThread: (threadId) => send({ type: "readThread", threadId }),
    getState: () => send({ type: "getState" }),
    retryWriter: () => writerAction("resumeThread"),
    inspectWriter: () => writerAction("inspectWriter"),
    takeoverWriter: (token) => writerAction("takeoverThread", { token, confirmed: true }),
    dismissWriter: () => { if (!writerRequest.current) setWriterConflict(null); },
  };

  const connected = conn === "open" && (cloud ? (!!agentPubRef.current && paired && !!relayState.codexConnected) : !!relayState.codexConnected);
  const selectAgent = id => { if (id !== selectedAgentRef.current && agents.some(agent => agent.id === id)) { selectedAgentRef.current = id; setAgentId(id); setSelectedTarget(id); } };
  return { conn, connected, cloud, agents, agentId, selectAgent, agentFp, relayState, config, models, writerConflict, writerBusy, writerError, events, approvals, diff, tree, actions, pair, pairError };
}
