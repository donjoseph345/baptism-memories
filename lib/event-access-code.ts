import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const CODE_PATTERN = /^[A-Z0-9]{6,32}$/;

export function normalizeEventAccessCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const normalized = input.trim().toUpperCase().replace(/[ -]/g, '');
  return CODE_PATTERN.test(normalized) ? normalized : null;
}

export function createEventAccessCode(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}

export async function hashEventAccessCode(code: string): Promise<{
  salt: string;
  hash: string;
}> {
  const normalized = normalizeEventAccessCode(code);
  if (!normalized) throw new Error('Invalid event access code.');

  const salt = randomBytes(SALT_BYTES);
  const derivedKey = (await scrypt(normalized, salt, KEY_LENGTH)) as Buffer;

  return {
    salt: salt.toString('base64url'),
    hash: derivedKey.toString('base64url'),
  };
}

export async function verifyEventAccessCode(
  code: string,
  saltBase64Url: string,
  expectedHashBase64Url: string,
): Promise<boolean> {
  const normalized = normalizeEventAccessCode(code);
  if (!normalized) return false;

  try {
    const salt = Buffer.from(saltBase64Url, 'base64url');
    const expectedHash = Buffer.from(expectedHashBase64Url, 'base64url');
    if (salt.length !== SALT_BYTES || expectedHash.length !== KEY_LENGTH) return false;

    const actualHash = (await scrypt(normalized, salt, KEY_LENGTH)) as Buffer;
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
