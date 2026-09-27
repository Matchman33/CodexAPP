import crypto from "node:crypto";
import { seal, open, sas } from "./e2e.mjs";

// 每条手机连接拥有独立的 Hub 身份，旧客户端也不会共用 legacy 会话。
export class AgentPhones {
  peers = new Map();

  constructor({ hub, keys, pairing, pairingMode, savePairing, send, changed = () => {} }) {
    Object.assign(this, { hub, keys, pairing, pairingMode, savePairing, send, changed });
  }

  async online(phoneId, pubkey) {
    if (!phoneId || !pubkey) return;
    this.offline(phoneId);
    const peer = { phoneId, pubkey, hubId: "cloud-" + crypto.randomUUID(), clientId: null,
      trusted: this.pairingMode() === "open" || this.pairing.pinnedPhones.includes(pubkey) };
    this.peers.set(phoneId, peer);
    this.changed();
    if (peer.trusted) await this.sendSnapshot(peer);
    else this.sendTo(peer, { type: "needPairing" });
  }

  async sendSnapshot(peer) {
    const snapshot = this.hub.attach ? await this.hub.attach(peer.hubId) : this.hub.snapshot(peer.hubId);
    this.sendTo(peer, snapshot);
  }

  offline(phoneId) {
    const peer = this.peers.get(phoneId);
    if (!peer) return;
    this.peers.delete(phoneId);
    this.hub.disconnect(peer.hubId);
    this.changed();
  }

  clear() { for (const id of [...this.peers.keys()]) this.offline(id); }

  sendTo(peer, message) {
    if (this.peers.get(peer.phoneId) !== peer) return;
    const payload = { ...message };
    if (payload.clientId) payload.clientId = peer.clientId || "legacy";
    if (payload.controller === peer.hubId) payload.controller = peer.clientId || "legacy";
    this.send({ type: "e2e", phoneId: peer.phoneId, ...seal(payload, peer.pubkey, this.keys.secretKey) });
  }

  broadcast(message) {
    for (const peer of this.peers.values()) {
      if (peer.trusted && (!message.clientId || message.clientId === peer.hubId)) this.sendTo(peer, message);
    }
  }

  async receive(message) {
    const peer = this.peers.get(message.phoneId);
    if (!peer) return;
    const inner = open(message, peer.pubkey, this.keys.secretKey);
    if (!inner || typeof inner.type !== "string") return;
    if (!peer.trusted) {
      if (inner.type !== "pair") return this.sendTo(peer, { type: "needPairing" });
      const expected = sas(this.pairing.code, this.keys.publicKey, peer.pubkey);
      if (inner.tag !== expected) return this.sendTo(peer, { type: "paired", ok: false, reason: "配对码不匹配或存在中间人" });
      if (!this.pairing.pinnedPhones.includes(peer.pubkey)) this.pairing.pinnedPhones.push(peer.pubkey);
      this.savePairing();
      peer.trusted = true;
      this.changed();
      this.sendTo(peer, { type: "paired", ok: true });
      return this.sendSnapshot(peer);
    }
    try {
      const clientId = inner.clientId || "legacy";
      if (!/^[a-zA-Z0-9_-]{1,160}$/.test(clientId) || (peer.clientId && peer.clientId !== clientId)) throw new Error("客户端标识无效或已改变，请重新连接");
      peer.clientId = clientId;
      await this.hub.dispatch({ ...inner, clientId: peer.hubId }, peer.hubId);
    } catch (error) {
      this.sendTo(peer, { type: "error", message: error.message, requestId: inner.requestId,
        clientId: peer.hubId, threadId: inner.threadId, terminalId: inner.terminalId });
    } finally {
      // 已受理命令可能在断线后完成，只清理此连接，不停止会话任务。
      if (this.peers.get(peer.phoneId) !== peer) this.hub.disconnect(peer.hubId);
    }
  }
}
