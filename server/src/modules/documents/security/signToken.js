import crypto from 'crypto';

const TOKEN_BYTES = 32;

/**
 * Opaque URL token (base64url). Store only SHA-256 hex in DB (`sign_token_hash`).
 */
export function generateSignToken() {
  const plainToken = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const tokenHash = hashSignToken(plainToken);
  return { plainToken, tokenHash };
}

export function hashSignToken(plainToken) {
  return crypto.createHash('sha256').update(String(plainToken), 'utf8').digest('hex');
}

/** Constant-time compare of two SHA-256 hex strings (64 chars). */
export function timingSafeEqualHex(a, b) {
  if (!a || !b || typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function getSignTokenTtlMs() {
  const days = Number(process.env.ESIGN_TOKEN_TTL_DAYS || 14);
  const d = Number.isFinite(days) && days > 0 ? Math.min(Math.floor(days), 365) : 14;
  return d * 24 * 60 * 60 * 1000;
}

export function signTokenExpiresAt(from = new Date()) {
  return new Date(from.getTime() + getSignTokenTtlMs());
}
