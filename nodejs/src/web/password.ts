/**
 * Password hashing & verification using Node.js built-in crypto.scrypt.
 *
 * Storage format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 *   - N: CPU/memory cost parameter
 *   - r: block size
 *   - p: parallelization
 *   - saltHex: random salt (hex)
 *   - hashHex: derived key (hex)
 *
 * scrypt is intentionally chosen over bcrypt because it is available in the
 * Node.js standard library (no native compilation required) and is resistant
 * to GPU/ASIC brute-force attacks through its memory-hard property.
 */

import crypto from "node:crypto";

/** Default scrypt parameters (N=16384, r=8, p=1). Tuned for ~100ms on modern hardware. */
const DEFAULT_N = 16384;
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const KEY_LEN = 64; // 512-bit derived key
const SALT_LEN = 32; // 256-bit salt

/**
 * Hash a plaintext password using scrypt.
 * @returns formatted string: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_LEN);
  const derivedKey = crypto.scryptSync(password, salt, KEY_LEN, {
    N: DEFAULT_N,
    r: DEFAULT_R,
    p: DEFAULT_P,
    maxmem: 128 * DEFAULT_N * DEFAULT_R * 2,
  });
  return `scrypt$${DEFAULT_N}$${DEFAULT_R}$${DEFAULT_P}$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Uses constant-time comparison to prevent timing attacks.
 * @returns true if password matches
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  const salt = Buffer.from(parts[4], "hex");
  const expectedHash = Buffer.from(parts[5], "hex");

  if (!N || !r || !p || salt.length === 0 || expectedHash.length === 0) {
    return false;
  }

  try {
    const derivedKey = crypto.scryptSync(password, salt, expectedHash.length, {
      N,
      r,
      p,
      maxmem: 128 * N * r * 2,
    });
    return crypto.timingSafeEqual(derivedKey, expectedHash);
  } catch {
    return false;
  }
}

/**
 * Validate password strength requirements.
 * @returns error message string if invalid, null if valid.
 */
export function validatePasswordStrength(password: string): string | null {
  if (password.length < 8) {
    return "密碼長度至少需要 8 個字元";
  }
  if (password.length > 128) {
    return "密碼長度不可超過 128 個字元";
  }
  return null;
}

/**
 * Validate username format.
 * @returns error message string if invalid, null if valid.
 */
export function validateUsername(username: string): string | null {
  if (!username || username.length < 3) {
    return "使用者名稱至少需要 3 個字元";
  }
  if (username.length > 64) {
    return "使用者名稱不可超過 64 個字元";
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    return "使用者名稱只能包含英文字母、數字、底線和連字號";
  }
  return null;
}
