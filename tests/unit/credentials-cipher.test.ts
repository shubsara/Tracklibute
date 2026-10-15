import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { CredentialDecryptionError, decryptSecret, encryptSecret } from "@/lib/crypto/credentials-cipher";

const key = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

describe("credentials cipher (AES-256-GCM)", () => {
  it("round-trips and never contains the plaintext", () => {
    const secret = JSON.stringify({ refresh_token: "1//super-secret" });
    const envelope = encryptSecret(secret, key, "integration:a:b");
    expect(envelope.startsWith("v1.")).toBe(true);
    expect(envelope).not.toContain("super-secret");
    expect(decryptSecret(envelope, key, "integration:a:b")).toBe(secret);
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("x", key, "aad")).not.toBe(encryptSecret("x", key, "aad"));
  });

  it("rejects a wrong key, wrong AAD (other org/integration), or tampered ciphertext", () => {
    const envelope = encryptSecret("secret", key, "integration:orgA:1");
    expect(() => decryptSecret(envelope, otherKey, "integration:orgA:1")).toThrow(CredentialDecryptionError);
    expect(() => decryptSecret(envelope, key, "integration:orgB:1")).toThrow(CredentialDecryptionError);
    const parts = envelope.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "integration:orgA:1")).toThrow(CredentialDecryptionError);
    expect(() => decryptSecret("garbage", key, "x")).toThrow(CredentialDecryptionError);
  });

  it("rejects keys that are not 32 bytes", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16).toString("base64"), "aad")).toThrow(/32 bytes/);
  });
});
