// /api/openf1.js
// Server-side proxy for the OpenF1 API.
//
// OpenF1 does send CORS headers, so the browser could hit it directly. The
// reason we proxy anyway is the 60-second edge cache + protection against
// brief upstream outages. The pattern mirrors /api/jolpica.
//
// Spec: see vibe-coding-brief/05-schema.md → "Serverless Function Contracts".

export default async function handler(req, res) {
  const target = typeof req.query.url === "string" ? req.query.url : "";

  if (!target) {
    return res.status(400).json({ error: "Missing 'url' query parameter" });
  }
  if (!target.startsWith("https://api.openf1.org/v1/")) {
    return res.status(400).json({ error: "Only api.openf1.org/v1/ URLs are allowed" });
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
