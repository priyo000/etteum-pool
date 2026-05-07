import { config } from "../config";

/**
 * Simple encryption/decryption using XOR with the encryption key.
 * For a personal project this is sufficient. For production, use AES-256-GCM.
 */

function getKeyBytes(): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(config.encryptionKey);
}

/**
 * Encrypt a string using XOR cipher + base64 encoding
 */
export function encrypt(plaintext: string): string {
  const key = getKeyBytes();
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const encrypted = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    encrypted[i] = data[i]! ^ key[i % key.length]!;
  }

  return Buffer.from(encrypted).toString("base64");
}

/**
 * Decrypt a base64-encoded XOR-encrypted string
 */
export function decrypt(ciphertext: string): string {
  const key = getKeyBytes();
  const data = new Uint8Array(Buffer.from(ciphertext, "base64"));
  const decrypted = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    decrypted[i] = data[i]! ^ key[i % key.length]!;
  }

  const decoder = new TextDecoder();
  return decoder.decode(decrypted);
}
