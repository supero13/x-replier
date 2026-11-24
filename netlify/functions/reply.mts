const PRIMARY = process.env.LLM_MODEL || "openai/gpt-oss-120b";
const FALLBACK = process.env.LLM_FALLBACK_MODEL || "openai/gpt-oss-20b";
const BASE = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || "";

const URL_MAX = 400;
const TEXT_MAX = 2000;
const BODY_MAX = 4000;
const TONES = new Set(["francis", "funny", "insightful", "supportive"]);
const HOST_RE = /^(www\.|mobile\.)?(x\.com|twitter\.com)$/i;
const STATUS_RE = /\/status(?:es)?\/(\d{5,20})(?:[/?#]|$)/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function parseXUrl(raw: string): { id: string; handle: string; url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > URL_MAX) return null;
  let u: URL;
  try {
    u = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!HOST_RE.test(u.hostname)) return null;
  const m = STATUS_RE.exec(u.pathname);
  if (!m) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const handle = parts[0] && parts[0] !== "i" && parts[0] !== "web" ? parts[0] : "i";
  return { id: m[1], handle, url: `https://x.com/${handle}/status/${m[1]}` };
}

type Quoted = { handle: string; name: string; text: string };
type Post = { id: string; handle: string; name: string; text: string; url: string; quoted: Quoted | null };

function asPost(raw: any, fallbackId: string, fallbackHandle: string): Post | null {
  const t = raw?.tweet || raw?.status || raw;
  if (!t || typeof t !== "object") return null;
  const author = t.author || t.user || {};
  const handle =
    author.screen_name || author.username || t.user_screen_name || fallbackHandle || "";
  const name = author.name || t.user_name || handle;
  const text = t.text || t.full_text || t.tweetText || "";
  const id = String(t.id || t.tweetID || fallbackId || "");
  if (!text || !id) return null;
  const q = t.quote || t.quoted_tweet || t.quoted_status || t.qrt || null;
  let quoted: Quoted | null = null;
  if (q && typeof q === "object") {
    const qt = q.text || q.full_text || "";
    const qa = q.author || q.user || {};
    const qh = qa.screen_name || qa.username || q.user_screen_name || "";
    if (qt) quoted = { handle: qh, name: qa.name || qh, text: String(qt) };
  }
  return {
    id,
    handle: String(handle).replace(/^@/, ""),
    name: String(name),
    text: String(text),
    url: `https://x.com/${String(handle).replace(/^@/, "") || "i"}/status/${id}`,
    quoted,
  };
}

function stripHtml(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

async function getJson(url: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "user-agent": "FrancisReplies/1.0", accept: "application/json" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPost(parsed: { id: string; handle: string; url: string }): Promise<Post | null> {
  const { id, handle, url } = parsed;
  const fx2 = await getJson(`https://api.fxtwitter.com/2/status/${id}`, 8000);
  let post = asPost(fx2, id, handle);
  if (post) return post;
  const fx1 = await getJson(`https://api.fxtwitter.com/${handle}/status/${id}`, 8000);
  post = asPost(fx1, id, handle);
  if (post) return post;
  const vx = await getJson(`https://api.vxtwitter.com/${handle}/status/${id}`, 8000);
  if (vx && typeof vx === "object") {
    const text = vx.text || vx.full_text || "";
    if (text) {
      let quoted: Quoted | null = null;
      const q = vx.qrt;
      if (q && typeof q === "object" && (q.text || q.full_text)) {
        quoted = {
          handle: q.user_screen_name || q.username || "",
          name: q.user_name || q.user_screen_name || "",
          text: q.text || q.full_text,
        };
      }
      return {
        id: String(vx.tweetID || vx.id || id),
        handle: String(vx.user_screen_name || handle).replace(/^@/, ""),
        name: String(vx.user_name || vx.user_screen_name || handle),
        text: String(text),
        url,
        quoted,
      };
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(`https://publish.twitter.com/oembed?omit_script=true&url=${encodeURIComponent(url)}`, {
      signal: ctrl.signal,
      headers: { "user-agent": "FrancisReplies/1.0" },
    });
    clearTimeout(timer);
    if (r.ok) {
      const o = await r.json();
      const text = stripHtml(String(o.html || ""));
      if (text) {
        const authorUrl = String(o.author_url || "");
        const hm = authorUrl.match(/((?:x|twitter)\.com)\/([^/?#]+)/i);
        const h = hm?.[2] || handle;
        return { id, handle: h, name: String(o.author_name || h), text, url, quoted: null };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

function toneHint(tone: string) {
  switch (tone) {
    case "funny":
      return "tone: funny. still lowercase and deadpan. one line, 3-12 words.";
    case "insightful":
      return "tone: insightful. 1-2 short sentences. add the missed insight.";
    case "supportive":
      return "tone: supportive and warm, not sycophantic. 1-2 short sentences.";
    default:
      return "tone: francis default. one line, 3-12 words. deadpan.";
  }
}

const SYSTEM = `You write a single X reply as Francis (@FrancisJD13).
Voice: all lowercase. deadpan funny but truthful. plain english only, no pidgin or slang. no hashtags, no brackets, almost no emojis. positive. add one insight the original post missed. never beg for follows. never just agree. end on a statement, not a question. never invent facts, names, or numbers.
Return JSON only: {"reply":"..."}`;

function cleanReply(s: string) {
  let t = s.trim().replace(/^["']|["']$/g, "").trim();
  t = t.replace(/#[\w_]+/g, "").replace(/\s+/g, " ").trim();
  return t;
}

async function groqChat(model: string, user: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 100,
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
      }),
    });
    const raw = await r.text();
    return { status: r.status, raw };
  } catch {
    return { status: 0, raw: "" };
  } finally {
    clearTimeout(timer);
  }
}

function parseModelReply(raw: string): string {
  try {
    const d = JSON.parse(raw);
    const content = d?.choices?.[0]?.message?.content || "";
    const o = typeof content === "string" ? JSON.parse(content.replace(/^```(?:json)?|```$/g, "").trim()) : content;
    return cleanReply(typeof o?.reply === "string" ? o.reply : "");
  } catch {
    return "";
  }
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!KEY) return json({ error: "Reply generation is not configured." }, 500);
  const raw = await req.text();
  if (raw.length > BODY_MAX) return json({ error: "That request is too long." }, 413);
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Bad JSON." }, 400);
  }
  const tone = TONES.has(body.tone) ? body.tone : "francis";
  const previous = typeof body.previous === "string" ? body.previous.slice(0, 280) : "";
  const urlIn = typeof body.url === "string" ? body.url.trim() : "";
  const textIn = typeof body.text === "string" ? body.text.trim() : "";
  if (urlIn && urlIn.length > URL_MAX) return json({ error: "That link is too long." }, 400);
  if (textIn && textIn.length > TEXT_MAX) return json({ error: "That text is too long. Keep it under 2000 characters." }, 400);

  let post: Post | null = null;
  if (urlIn) {
    const parsed = parseXUrl(urlIn);
    if (!parsed) {
      return json({ error: "Paste a public X or Twitter post link, like https://x.com/name/status/123." }, 400);
    }
    post = await fetchPost(parsed);
    if (!post && !textIn) {
      return json({ error: "Couldn't load that post. Paste the text instead.", needsManual: true, postId: parsed.id }, 422);
    }
    if (!post && textIn) {
      post = {
        id: parsed.id,
        handle: parsed.handle === "i" ? "" : parsed.handle,
        name: parsed.handle === "i" ? "" : parsed.handle,
        text: textIn,
        url: parsed.url,
        quoted: null,
      };
    }
  } else if (textIn) {
    post = { id: "", handle: "", name: "", text: textIn, url: "", quoted: null };
  } else {
    return json({ error: "Paste an X post link first." }, 400);
  }
  if (!post) return json({ error: "Couldn't load that post. Paste the text instead.", needsManual: true }, 422);

  let user = `Author: ${post.name ? `${post.name} (@${post.handle})` : post.handle ? `@${post.handle}` : "unknown"}\nPost: ${JSON.stringify(post.text)}`;
  if (post.quoted) user += `\nQuoted post by @${post.quoted.handle}: ${JSON.stringify(post.quoted.text)}`;
  user += `\n${toneHint(tone)}`;
  if (previous) user += `\nDo not repeat this reply: ${JSON.stringify(previous)}`;

  const first = await groqChat(PRIMARY, user);
  let model = PRIMARY;
  let usedFallback = false;
  let result = first;
  if (first.status === 429) {
    const second = await groqChat(FALLBACK, user);
    model = FALLBACK;
    usedFallback = true;
    result = second;
    if (second.status === 429) {
      return json({
        error: "Groq's free limit is used up for now. Try again in a bit.",
        rateLimited: true,
        post,
      }, 429);
    }
  }
  if (result.status !== 200) {
    return json({ error: "Couldn't write a reply just now. Try again." }, 502);
  }
  const reply = parseModelReply(result.raw);
  if (!reply) return json({ error: "Couldn't write a reply just now. Try again." }, 502);
  return json({
    post,
    reply,
    model,
    usedFallback,
  });
};
