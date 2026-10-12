// Minimal in-memory fixed-window rate limiter (per IP + route key).
// For multi-instance deployments, replace with a shared store (e.g. Redis).
export const rateLimit = ({ windowMs = 15 * 60 * 1000, max = 10, key = "" } = {}) => {
  const hits = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const id = `${key}:${req.ip}`;
    const now = Date.now();
    let entry = hits.get(id);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(id, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", Math.ceil((entry.reset - now) / 1000));
      return res.status(429).json({ message: "Too many requests, please try again later." });
    }
    next();
  };
};
