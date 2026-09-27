import crypto from "node:crypto";

const send = (ws, message) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(message));
};

// 账号隔离在此处完成；phoneId 只由 Broker 分配，不采信客户端的路由字段。
export class LinkRouter {
  rooms = new Map();

  join(ws, accountId, { role, pubkey, multiPhone = false, deviceKey, identityVerified = false }) {
    multiPhone = multiPhone === true;
    let room = this.rooms.get(accountId);
    if (!room) room = { agent: null, phones: new Map() };
    const previous = room.agent;
    if (role === "agent" && previous && !(identityVerified && deviceKey && previous.deviceKey === deviceKey && previous.pubkey === pubkey)) {
      return this.reject(ws, "agent_already_online", "此账号已有其他在线 Agent，请先退出原 Agent");
    }
    if ((role === "agent" && !multiPhone && room.phones.size > 1) ||
        (role === "phone" && room.agent && !room.agent.multiPhone && room.phones.size)) {
      return this.reject(ws, "agent_upgrade_required", "多客户端连接需要更新电脑 Agent");
    }
    this.rooms.set(accountId, room);
    Object.assign(ws, { accountId, role, pubkey, multiPhone: multiPhone === true, deviceKey: identityVerified ? deviceKey : null });
    if (role === "agent") {
      room.agent = ws;
      if (previous) {
        send(previous, { type: "error", code: "agent_replaced", message: "同一设备已重新连接，旧连接已退出" });
        previous.close(4008, "agent reconnected");
      }
      const peers = [...room.phones].map(([phoneId, phone]) => ({ phoneId, pubkey: phone.pubkey }));
      send(ws, { type: "authed", role, multiPhone: true, deviceIdentity: !!ws.deviceKey, peerOnline: !!peers.length,
        ...(ws.multiPhone ? { peers } : { peerPubkey: peers[0]?.pubkey || null }) });
      for (const phone of room.phones.values()) send(phone, { type: "peer", online: true, pubkey });
    } else {
      ws.phoneId = crypto.randomUUID();
      room.phones.set(ws.phoneId, ws);
      send(ws, { type: "authed", role, peerOnline: !!room.agent, peerPubkey: room.agent?.pubkey || null });
      send(room.agent, { type: "peer", online: true, phoneId: ws.phoneId, pubkey });
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
      if (room.agent !== ws) return;
      const phone = ws.multiPhone ? room.phones.get(message.phoneId) : room.phones.values().next().value;
      if (phone) send(phone, { type: "e2e", from: "agent", nonce: message.nonce, box: message.box });
    } else {
      if (room.phones.get(ws.phoneId) !== ws) return;
      if (room.agent) send(room.agent, { type: "e2e", from: "phone", phoneId: ws.phoneId, nonce: message.nonce, box: message.box });
      else send(ws, { type: "peer", online: false });
    }
  }

  leave(ws) {
    const room = this.rooms.get(ws.accountId);
    if (!room) return;
    if (ws.role === "agent" && room.agent === ws) {
      room.agent = null;
      for (const phone of room.phones.values()) send(phone, { type: "peer", online: false });
    } else if (ws.role === "phone" && room.phones.get(ws.phoneId) === ws) {
      room.phones.delete(ws.phoneId);
      send(room.agent, { type: "peer", online: false, phoneId: ws.phoneId });
    }
    if (!room.agent && !room.phones.size) this.rooms.delete(ws.accountId);
  }

  disconnectAccount(accountId, code = "session_revoked", message = "登录 token 已撤销，请重新登录", closeCode = 4001) {
    const room = this.rooms.get(accountId);
    if (!room) return;
    this.rooms.delete(accountId);
    for (const ws of [room.agent, ...room.phones.values()]) {
      send(ws, { type: "error", code, message });
      ws?.close(closeCode, code);
    }
  }
}
