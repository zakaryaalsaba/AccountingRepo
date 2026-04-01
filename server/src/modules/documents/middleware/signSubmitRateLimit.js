import crypto from 'crypto';

function defaultWindowMs() {
  const v = Number(process.env.ESIGN_SIGN_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 15 * 60 * 1000;
}

function defaultMax() {
  const v = Number(process.env.ESIGN_SIGN_RATE_LIMIT_MAX);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 20;
}

function hashKeyPart(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Throttle POST /sign/:token — key = IP + token hash (per link per client).
 */
export function signSubmitRateLimit(options = {}) {
  const windowMs = options.windowMs ?? defaultWindowMs();
  const max = options.max ?? defaultMax();
  const buckets = new Map();

  return function signSubmitRateLimitMiddleware(req, res, next) {
    const token = req.params?.token || '';
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${ip}:${hashKeyPart(token)}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.set('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many signing attempts' });
    }
    next();
  };
}
