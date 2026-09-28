// /api/openf1.js
// Server-side proxy for the OpenF1 API.
//
// OpenF1 does send CORS headers, so the browser could hit it directly. The
// reason we proxy anyway is the 60-second edge cache + protection against
// brief upstream outages. The pattern mirrors /api/jolpica.

const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  const target = typeof req.query.url === "string" ? req.query.url : "";

  if (!target) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }
  if (!target.startsWith("https://api.openf1.org/v1/")) {
    return res.status(400).json({ error: "Only api.openf1.org/v1/ URLs are allowed" });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "PitWall/2.0 (+vercel)" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    if (upstream.status === 429) {
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=120");
      const retryAfter = upstream.headers.get("retry-after");
      if (retryAfter) res.setHeader("Retry-After", retryAfter);
    } else {
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    }
    res.setHeader("Content-Type", contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    clearTimeout(timer);
    const isAbort = err && (err.name === "AbortError" || /aborted/i.test(String(err.message || err)));
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? "Upstream timed out" : "Upstream fetch failed",
      detail: String(err && err.message || err),
    });
  }
}
