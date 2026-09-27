export function createAuthRateLimit({ windowMs = 15 * 60 * 1000, max = 8, now = Date.now } = {}) {
  const attempts = new Map();
  return key => {
    const time = now();
    const recent = (attempts.get(key) || []).filter(t => time - t < windowMs);
    // Rejected requests must not extend the wait for the next available slot.
    const retryAfter = recent.length >= max ? Math.max(1, Math.ceil((recent[0] + windowMs - time) / 1000)) : 0;
    if (!retryAfter) recent.push(time);
    attempts.set(key, recent);
    return retryAfter;
  };
}
