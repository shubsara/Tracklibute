import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for integration credentials at rest.
 *
 * Format: `v1.<iv>.<authTag>.<ciphertext>` (base64url parts).
 * `aad` (additional authenticated data) binds a ciphertext to its owner, e.g.
 * `integration:<orgId>:<integrationId>`, so a blob copied to another
 * organization's row fails to decrypt.
 *
 * NOT production key management: the key comes from an environment variable.
 * Production must source it from a managed secret store / KMS with rotation
 * (see README → Security model).
 */
const VERSION = "v1";
const IV_BYTES = 12;

export class CredentialDecryptionError extends Error {
  constructor() {
    super("Credential payload could not be decrypted");
    this.name = "CredentialDecryptionError";
  }
}

function decodeKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes (base64-encoded)");
  return key;
}

export function encryptSecret(plaintext: string, base64Key: string, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", decodeKey(base64Key), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ".",
  );
}

export function decryptSecret(envelope: string, base64Key: string, aad: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new CredentialDecryptionError();
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string];
  try {
    const decipher = createDecipheriv("aes-256-gcm", decodeKey(base64Key), Buffer.from(ivB64, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    // Never surface the underlying error: it may include fragments of input.
    throw new CredentialDecryptionError();
  }
}
