// Connects the app to Claude.
// When the page runs on claude.ai, it uses the viewer's own Claude account.
// When it runs on your own site, it calls /api/claude (netlify/functions/claude.mjs or server.mjs),
// which holds the API key on the server.

/** Pull one JSON value out of a reply, tolerating a code fence or a sentence around it. */
export function parseJSON(text) {
  const t = String(text ?? "").trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const starts = ["{", "["].map((ch) => t.indexOf(ch)).filter((i) => i >= 0);
  const a = starts.length ? Math.min(...starts) : -1;
  const z = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (a >= 0 && a < z) { try { return JSON.parse(t.slice(a, z + 1)); } catch {} }
  throw { code: "invalid_json" };
}

/** Resize an image so text stays readable but the upload stays small. */
async function toPayload(file, max = 2000) {
  const img = await createImageBitmap(file);
  const sc = Math.min(1, max / Math.max(img.width, img.height));
  const c = document.createElement("canvas");
  c.width = Math.round(img.width * sc);
  c.height = Math.round(img.height * sc);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return { media_type: "image/png", data: c.toDataURL("image/png").split(",")[1] };
}

function serverAI(info) {
  return {
    source: "server",
    model: info.model,
    maxImages: info.maxImages || 6,
    async json(prompt, { images = [], signal, purpose = "read" } = {}) {
      const payload = { prompt, purpose, images: await Promise.all([...images].map((f) => toPayload(f))) };
      let r;
      try {
        r = await fetch("/api/claude", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal });
      } catch (e) {
        throw { code: e?.name === "AbortError" ? "cancelled" : "upstream_error" };
      }
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw { code: d.code || (r.status === 429 ? "rate_limited" : "upstream_error"), message: d.error };
      }
      let text;
      try { text = await r.text(); } catch (e) { throw { code: e?.name === "AbortError" ? "cancelled" : "upstream_error" }; }
      const err = text.match(/\[\[DF_ERROR:(\w+)\]\]/);
      if (err) throw { code: err[1] };
      return parseJSON(text);
    },
  };
}

function claudeAiAI(sample, limits) {
  return {
    source: "claude.ai",
    maxImages: limits?.images?.maxCount || 6,
    canImages: !!limits?.images,
    json(prompt, { images, signal } = {}) {
      return sample.json(prompt, images && images.length ? { images, signal } : { signal });
    },
  };
}

/** Resolve the AI connection, or null when there is none (students can still type classes). */
export async function connectAI() {
  if (window.claude?.use) {
    try {
      const sample = await window.claude.use("sample");
      if (sample) {
        const limits = await sample.limits().catch(() => null);
        return claudeAiAI(sample, limits);
      }
    } catch {}
    return null;
  }
  try {
    const r = await fetch("/api/claude", { method: "GET", headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const info = await r.json();
    return info.ok ? serverAI(info) : null;
  } catch {
    return null;
  }
}

/** Friendly text for each error code. */
export const AI_ERRORS = {
  not_granted: "Claude wasn't allowed for this page. You can type your classes instead.",
  sampling_disabled: "The AI reader isn't set up on this site yet. You can type your classes instead.",
  rate_limited: "Too many requests right now. Wait a few minutes and try again.",
  image_rejected: "One of the images couldn't be read. Try a PNG or JPG screenshot.",
  invalid_json: "The AI's answer came back incomplete. Try again, or use fewer images at once.",
  refused: "The AI couldn't read these images. Try clearer screenshots.",
  session_expired: "Sign in again, then retry.",
  images_unavailable: "Images can't be sent from here. You can type your classes instead.",
  prompt_too_large: "That's too much at once. Try fewer images.",
  invalid_request: "The request was rejected. Try fewer or smaller images.",
  upstream_error: "The AI didn't answer. Check your connection and try again.",
};
