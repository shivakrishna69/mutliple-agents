/**
 * Sealing short secrets the server must store and read back (AES-256-GCM): e.g. the activation link
 * of an imported employee whose email could not be sent, kept until HR collects it. Stored sealed,
 * a database leak does not hand out working links.
 *
 * The key is derived from a server secret with HKDF, separately for each `purpose`, so one sealed
 * value cannot be opened as another kind. Changing the server secret makes earlier values
 * unreadable, which only means HR resends those invitations.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

const deriveKey = (serverSecret, purpose) =>
  Buffer.from(hkdfSync('sha256', serverSecret, Buffer.alloc(0), `secret-box:${purpose}`, KEY_BYTES));

export function sealSecret(plaintext, { serverSecret, purpose }) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(serverSecret, purpose), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext]
    .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
    .join('.');
}

/** The plaintext, or null when the value was sealed with another secret or purpose, or altered. */
export function openSecret(sealed, { serverSecret, purpose }) {
  const [version, iv, tag, ciphertext] = String(sealed).split('.');
  if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(serverSecret, purpose), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
