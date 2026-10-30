import { createHash, randomBytes } from 'node:crypto';

export function createGuestToken() { return randomBytes(24).toString('base64url'); }
export function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function safeSlug(input: string) {
  return input.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55);
}
