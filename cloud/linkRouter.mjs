import crypto from "node:crypto";

const send = (ws, message) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
};

// 账号隔离在此处完成；phoneId 只由 Broker 分配，不采信客户端的路由字段。
export class LinkRouter {
  rooms = new Map();

  agents(room) {
    return [...room.agents.values()].map(ws => ({ id: ws.agentId, name: ws.deviceName, pubkey: ws.pubkey }));
  }

  announce(room) {
    for (const phone of room.phones.values()) if (phone.multiAgent) send(phone, { type: "agents", agents: this.agents(room), agentId: phone.agentId });
  }

  join(ws, accountId, { role, pubkey, multiPhone = false, deviceKey, identityVerified = false, multiAgent = false, agentId = null, deviceName }) {
    multiPhone = multiPhone === true;
    let room = this.rooms.get(accountId);
    if (!room) room = { agents: new Map(), phones: new Map() };
    if (role === "agent") {
      agentId = identityVerified && deviceKey ? crypto.createHash("sha256").update(deviceKey).digest("hex") : "legacy";
      if (room.agents.size && (agentId === "legacy" || room.agents.has("legacy"))) return this.reject(ws, "agent_already_online", "同账号多电脑需要所有 Agent 升级设备身份认证");
    } else {
      if (agentId !== null && (typeof agentId !== "string" || !/^(?:[a-f0-9]{64}|legacy)$/.test(agentId))) return this.reject(ws, "invalid_agent", "无效的电脑标识");
      if (!agentId && room.agents.size === 1) agentId = room.agents.keys().next().value;
      if (!agentId && room.agents.size > 1 && multiAgent !== true) return this.reject(ws, "agent_selection_required", "此账号有多台电脑，请更新客户端后选择电脑");
    }
    const peersFor = id => [...room.phones.values()].filter(phone => phone.agentId === id);
    if ((role === "agent" && !multiPhone && [...room.phones.values()].filter(phone => phone.agentId === agentId || !phone.agentId).length > 1) ||
        (role === "phone" && room.agents.get(agentId)?.multiPhone === false && peersFor(agentId).length)) return this.reject(ws, "agent_upgrade_required", "多客户端连接需要更新电脑 Agent");
    this.rooms.set(accountId, room);
    Object.assign(ws, { accountId, role, pubkey, multiPhone, multiAgent: multiAgent === true, agentId, deviceKey: identityVerified ? deviceKey : null });
    if (role === "agent") {
      const previous = room.agents.get(agentId);
      ws.deviceName = typeof deviceName === "string" && deviceName.trim() ? deviceName.trim().slice(0, 80) : "电脑 " + agentId.slice(0, 8);
      room.agents.set(agentId, ws);
      if (previous) {
        send(previous, { type: "error", code: "agent_replaced", message: "同一设备已重新连接，旧连接已退出" });
        previous.close(4008, "agent reconnected");
      }
      if (room.agents.size === 1) for (const phone of room.phones.values()) if (!phone.agentId) phone.agentId = agentId;
      const peers = peersFor(agentId).map(phone => ({ phoneId: phone.phoneId, pubkey: phone.pubkey }));
      send(ws, { type: "authed", role, agentId, multiAgent: true, multiPhone: true, deviceIdentity: !!ws.deviceKey, peerOnline: !!peers.length,
        ...(ws.multiPhone ? { peers } : { peerPubkey: peers[0]?.pubkey || null }) });
      for (const phone of peersFor(agentId)) send(phone, { type: "peer", online: true, agentId, pubkey });
      this.announce(room);
    } else {
      ws.phoneId = crypto.randomUUID();
      room.phones.set(ws.phoneId, ws);
      const agent = room.agents.get(agentId);
      send(ws, { type: "authed", role, multiAgent: true, agents: this.agents(room), agentId, peerOnline: !!agent, peerPubkey: agent?.pubkey || null });
      send(agent, { type: "peer", online: true, phoneId: ws.phoneId, pubkey });
    }
    return true;
  }

  reject(ws, code, message) {
    send(ws, { type: "error", code, message });
    ws.close(4009, code);
    return false;
  }

  forward(ws, message) {
    const room = this.rooms.get(ws.accountId);
    if (!room || message.type !== "e2e") return;
    if (ws.role === "agent") {
      if (room.agents.get(ws.agentId) !== ws) return;
      const phone = ws.multiPhone ? room.phones.get(message.phoneId) : [...room.phones.values()].find(phone => phone.agentId === ws.agentId);
      if (phone?.agentId === ws.agentId) send(phone, { type: "e2e", from: "agent", agentId: ws.agentId, nonce: message.nonce, box: message.box });
    } else {
      if (room.phones.get(ws.phoneId) !== ws) return;
      const agent = room.agents.get(ws.agentId);
      if (agent) send(agent, { type: "e2e", from: "phone", phoneId: ws.phoneId, nonce: message.nonce, box: message.box });
      else send(ws, { type: "peer", online: false, agentId: ws.agentId });
    }
  }

  leave(ws) {
    const room = this.rooms.get(ws.accountId);
    if (!room) return;
    if (ws.role === "agent" && room.agents.get(ws.agentId) === ws) {
      room.agents.delete(ws.agentId);
      for (const phone of room.phones.values()) if (phone.agentId === ws.agentId) send(phone, { type: "peer", online: false, agentId: ws.agentId });
      this.announce(room);
    } else if (ws.role === "phone" && room.phones.get(ws.phoneId) === ws) {
      room.phones.delete(ws.phoneId);
      send(room.agents.get(ws.agentId), { type: "peer", online: false, phoneId: ws.phoneId });
    }
    if (!room.agents.size && !room.phones.size) this.rooms.delete(ws.accountId);
  }

  disconnectAccount(accountId, code = "session_revoked", message = "登录 token 已撤销，请重新登录", closeCode = 4001) {
    const room = this.rooms.get(accountId);
    if (!room) return;
    this.rooms.delete(accountId);
    for (const ws of [...room.agents.values(), ...room.phones.values()]) {
      send(ws, { type: "error", code, message });
      ws?.close(closeCode, code);
    }
  }
}
