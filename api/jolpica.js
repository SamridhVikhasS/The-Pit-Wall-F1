// /api/jolpica.js
// Server-side proxy for the Jolpica F1 API.
//
// Jolpica does not send CORS headers, so direct browser fetches are blocked.
// This function runs on Vercel's edge, fetches upstream, and re-emits the
// response with permissive CORS + a 60-second edge cache. Validates that the
// target URL belongs to Jolpica so this can't be turned into an open relay.
//
// Spec: see vibe-coding-brief/05-schema.md → "Serverless Function Contracts".

const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  const target = typeof req.query.url === "string" ? req.query.url : "";

  if (!target) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }
  if (!target.startsWith("https://api.jolpi.ca/ergast/f1/")) {
    return res.status(400).json({ error: "Only api.jolpi.ca/ergast/f1/ URLs are allowed" });
  }

  // Abort the upstream fetch if it takes longer than our budget. The Vercel
  // Hobby tier kills the function at 10s anyway; failing at 8s lets us return
  // a clean 504 with CORS headers instead of having Vercel hard-kill us.
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

    // For 429 responses, cache briefly so we don't spam the upstream while
    // it's already complaining about rate.
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
