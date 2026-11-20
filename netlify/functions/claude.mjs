// Degree Flow AI proxy. Keeps your Anthropic API key on the server and streams Claude's answer back.
// Set ANTHROPIC_API_KEY in Netlify: Site configuration > Environment variables.
// Optional: CLAUDE_MODEL (default claude-sonnet-5-5), HOURLY_LIMIT (default 20 calls per visitor per hour).

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const HOURLY_LIMIT = Number(process.env.HOURLY_LIMIT || 20);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // base64 length cap per image
const MAX_PROMPT = 120000;
const TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const SYSTEM = "You read university degree flowcharts and student planning requests and turn them into exact JSON. Be careful and literal: copy course codes and prerequisite lines exactly as printed, never invent courses, and reply with JSON only.";

const seen = new Map(); // simple limiter (resets when the server restarts)
function limited(ip) {
  const now = Date.now(), hour = 3600_000;
  const list = (seen.get(ip) || []).filter(t => now - t < hour);
  if (list.length >= HOURLY_LIMIT) { seen.set(ip, list); return true; }
  list.push(now); seen.set(ip, list); return false;
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default async (req, context) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === "GET") return json({ ok: !!key, model: key ? MODEL : null, maxImages: MAX_IMAGES });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!key) return json({ code: "sampling_disabled", error: "The site owner hasn't added an API key yet." }, 503);

  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "anon";
  if (limited(ip)) return json({ code: "rate_limited", error: "Too many requests. Try again in an hour." }, 429);

  let body;
  try { body = await req.json(); } catch { return json({ code: "invalid_request", error: "Bad JSON" }, 400); }
  const prompt = typeof body?.prompt === "string" ? body.prompt : "";
  const images = Array.isArray(body?.images) ? body.images : [];
  if (!prompt || prompt.length > MAX_PROMPT) return json({ code: "prompt_too_large", error: "Prompt missing or too long" }, 400);
  if (images.length > MAX_IMAGES) return json({ code: "image_rejected", error: `Up to ${MAX_IMAGES} images` }, 400);
  for (const im of images) {
    if (!im || !TYPES.has(im.media_type) || typeof im.data !== "string" || im.data.length > MAX_IMAGE_BYTES)
      return json({ code: "image_rejected", error: "Image type or size not accepted" }, 400);
  }

  const content = [
    ...images.map((im, i) => [{ type: "text", text: `Image ${i + 1} of ${images.length}:` }, { type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }]).flat(),
    { type: "text", text: prompt },
  ];

  let upstream;
  try {
    upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 16000, temperature: 0, stream: true, system: SYSTEM, messages: [{ role: "user", content }] }),
    });
  } catch {
    return json({ code: "upstream_error", error: "Couldn't reach Claude" }, 502);
  }
  if (!upstream.ok) {
    const code = upstream.status === 429 || upstream.status === 529 ? "rate_limited" : upstream.status === 400 ? "invalid_request" : "upstream_error";
    let detail = ""; try { detail = (await upstream.json())?.error?.message || ""; } catch {}
    console.error("Anthropic error", upstream.status, detail);
    return json({ code, error: code === "rate_limited" ? "Claude is busy. Try again in a few minutes." : "Claude returned an error" }, code === "rate_limited" ? 429 : 502);
  }

  // Turn Anthropic's event stream into plain text so the browser just reads the answer.
  const enc = new TextEncoder(), dec = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      const reader = upstream.body.getReader();
      let buf = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const evt = buf.slice(0, i); buf = buf.slice(i + 2);
            const line = evt.split("\n").find(l => l.startsWith("data:"));
            if (!line) continue;
            let d; try { d = JSON.parse(line.slice(5)); } catch { continue; }
            if (d.type === "content_block_delta" && d.delta?.type === "text_delta") controller.enqueue(enc.encode(d.delta.text));
            if (d.type === "error") controller.enqueue(enc.encode("\n[[DF_ERROR:upstream_error]]"));
            if (d.type === "message_delta" && d.delta?.stop_reason === "max_tokens") controller.enqueue(enc.encode("\n[[DF_ERROR:invalid_json]]"));
          }
        }
      } catch {
        controller.enqueue(enc.encode("\n[[DF_ERROR:upstream_error]]"));
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
};

export const config = { path: "/api/claude" };
