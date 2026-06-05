// /api/jolpica.js
// Server-side proxy for the Jolpica F1 API.
//
// Jolpica does not send CORS headers, so direct browser fetches are blocked.
// This function runs on Vercel's edge, fetches upstream, and re-emits the
// response with permissive CORS + a 60-second edge cache. Validates that the
// target URL belongs to Jolpica so this can't be turned into an open relay.
//
// Spec: see vibe-coding-brief/05-schema.md → "Serverless Function Contracts".

export default async function handler(req, res) {
  const target = typeof req.query.url === "string" ? req.query.url : "";

  if (!target) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }
  if (!target.startsWith("https://api.jolpi.ca/ergast/f1/")) {
    return res.status(400).json({ error: "Only api.jolpi.ca/ergast/f1/ URLs are allowed" });
  }

  try {
    const upstream = await fetch(target, {
      headers: { "User-Agent": "PitWall/2.0 (+vercel)" },
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/json";

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    res.setHeader("Content-Type", contentType);
    return res.status(upstream.status).send(body);
  } catch (err) {
    return res.status(502).json({
      error: "Upstream fetch failed",
      detail: String(err && err.message || err),
    });
  }
}
