/*
  Photo relay for the journal order page (Cloudflare Worker).
  The order page sends a customer's photo here; this worker asks Claude to describe the
  look as character settings and returns them. The photo is not stored.

  Setup (once):
   1. Cloudflare dashboard > Workers & Pages > Create > "Hello World" worker > Deploy.
   2. Edit code: replace everything with this file > Deploy.
   3. Settings > Variables and Secrets > add a SECRET named ANTHROPIC_API_KEY (your Anthropic API key).
      Optional text variables: ALLOWED_ORIGIN (default below), MODEL (default below).
   4. Copy the worker address (https://NAME.SUBDOMAIN.workers.dev) into SHOP.photoApi in design/index.html.
*/
const DEFAULT_ORIGIN = "https://sanati-journal.github.io";
const DEFAULT_MODEL = "claude-haiku-5-5";
const MAX_IMAGE_B64 = 1_600_000;      // about 1.2 MB of JPEG
const PER_MINUTE = 6;                 // photos per visitor per minute (best effort)

const OPT = {
  faceShape: ["oval", "round", "square", "heart"],
  hair: ["curly_long", "curly_short", "straight_long", "wavy_medium", "bob", "ponytail", "bun", "afro", "short_crop", "side_part", "buzz", "bald", "hijab"],
  facial: ["none", "stubble", "short", "full", "mustache", "goatee"],
  glasses: ["none", "round", "square"],
  dress: ["none", "gown", "sundress", "abaya"],
  top: ["tshirt", "shirt", "blouse", "polo", "tank", "hoodie", "sweater", "cardigan", "blazer"],
  bottom: ["trousers", "jeans", "shorts", "skirt", "skirt_long", "sweatpants"],
  shoes: ["sneakers", "dress", "heels", "sandals", "slippers", "boots"],
};
const L = k => OPT[k].join(", ");
const FACE_JSON = `"skin": hex color closest to their skin tone, "faceShape": one of [${L("faceShape")}], "hair": one of [${L("hair")}] (use "hijab" if they wear a headscarf), "hairColor": hex, "hijabColor": hex or null, "eyes": hex eye color, "brows": "thin" or "thick", "facial": one of [${L("facial")}], "glasses": one of [${L("glasses")}],
 "outfit": {"dress": one of [${L("dress")}], "top": one of [${L("top")}], "topColor": hex, "bottom": one of [${L("bottom")}], "bottomColor": hex, "dressColor": hex or null, "shoes": one of [${L("shoes")}]}`;

function promptFor(body) {
  if (body.mode === "group") {
    const members = (Array.isArray(body.members) ? body.members : []).slice(0, 5)
      .filter(m => m && /^(owner|partner|kid[0-2])$/.test(m.id))
      .map(m => {
        const male = m.g === "m", years = Number.isFinite(+m.years) && m.years !== null ? Math.max(0, Math.min(99, Math.round(+m.years))) : null;
        const role = m.id.startsWith("kid")
          ? (m.kid ? (male ? "boy" : "girl") : (male ? "adult son" : "adult daughter")) + (years !== null ? `, about ${years}` : "")
          : (male ? "man" : "woman");
        return { id: m.id, role };
      });
    if (!members.length) return null;
    return `This photo shows a ${body.family ? "family" : "couple"}. These are the people to find (match each by role, age and position):
${JSON.stringify(members)}
For each person you can see, choose settings for a cute cartoon avatar, matching what they look like and what they are wearing.
Reply with only a JSON object keyed by the "id" values above (leave out anyone you cannot see), each value:
{${FACE_JSON}}
Pick the closest options. Do not identify anyone; only describe appearance.`;
  }
  return `Look at the person in this photo and choose settings for a cute cartoon avatar of them, matching what they look like and what they are wearing. Reply with only a JSON object:
{${FACE_JSON}}
Pick the closest options. Do not identify the person; only describe appearance.`;
}

const hits = new Map();
function limited(ip) {
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 60_000);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_MINUTE;
}

export default {
  async fetch(req, env) {
    const allowed = (env.ALLOWED_ORIGIN || DEFAULT_ORIGIN).split(",").map(s => s.trim());
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0], "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    if (!allowed.includes(origin)) return json({ error: "origin not allowed" }, 403);
    if (!env.ANTHROPIC_API_KEY) return json({ error: "relay not configured" }, 500);
    if (limited(req.headers.get("CF-Connecting-IP") || "x")) return json({ error: "slow down" }, 429);

    let body;
    try { body = await req.json(); } catch (e) { return json({ error: "bad request" }, 400); }
    const image = typeof body.image === "string" ? body.image : "";
    if (!image || image.length > MAX_IMAGE_B64 || !/^[A-Za-z0-9+/=]+$/.test(image)) return json({ error: "bad image" }, 400);
    const prompt = promptFor(body);
    if (!prompt) return json({ error: "bad request" }, 400);

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: env.MODEL || DEFAULT_MODEL, max_tokens: 900,
        messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } }, { type: "text", text: prompt }] }],
      }),
    });
    if (r.status === 429 || r.status === 529) return json({ error: "busy" }, 429);
    if (!r.ok) return json({ error: "upstream " + r.status }, 502);
    const data = await r.json();
    const text = (data.content || []).filter(c => c.type === "text").map(c => c.text).join("");
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b <= a) return json({ error: "no result" }, 502);
    try { return json(JSON.parse(text.slice(a, b + 1))); } catch (e) { return json({ error: "no result" }, 502); }
  },
};
