import crypto from "node:crypto";
import fs from "node:fs";

export function loadDeviceIdentity(file) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const pair = crypto.generateKeyPairSync("ed25519");
  const identity = {
    publicKey: pair.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  fs.writeFileSync(file, JSON.stringify(identity), { mode: 0o600, flag: "wx" });
  return identity;
}

export function signDeviceChallenge(identity, challenge) {
  if (typeof challenge !== "string" || !challenge.startsWith("codexapp-agent:") || challenge.length > 1024) throw new Error("无效设备认证挑战");
  return crypto.sign(null, Buffer.from(challenge), identity.privateKey).toString("base64");
}

export function verifyDeviceProof(publicKey, challenge, signature) {
  try {
    if (typeof publicKey !== "string" || publicKey.length > 256 || typeof signature !== "string" || signature.length > 128) return false;
    const key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && crypto.verify(null, Buffer.from(challenge), key, Buffer.from(signature, "base64"));
  } catch { return false; }
}
