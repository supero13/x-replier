const PRIMARY = process.env.LLM_MODEL || "openai/gpt-oss-120b";
const FALLBACK = process.env.LLM_FALLBACK_MODEL || "openai/gpt-oss-20b";
const BASE = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || "";

const URL_MAX = 400;
const TEXT_MAX = 2000;
const BODY_MAX = 4000;
const TONES = new Set(["francis", "funny", "insightful", "supportive"]);
const HOST_RE = /^(www\.|mobile\.)?(x\.com|twitter\.com)$/i;
const STATUS_RE = /\/status(?:es)?\/(\d{2,20})(?:[/?#]|$)/i;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

function parseXUrl(raw: string): { id: string; handle: string; url: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > URL_MAX) return null;
  const found = trimmed.match(/https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^\s]+/i)
    || trimmed.match(/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^\s]+/i);
  const candidate = found ? found[0] : trimmed;
  let u: URL;
  try {
    u = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
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
type Parent = { id: string; handle: string; name: string; text: string; url: string };
type Post = {
  id: string;
  handle: string;
  name: string;
  text: string;
  url: string;
  quoted: Quoted | null;
  parent: Parent | null;
  isComment: boolean;
};

function extractReplyTo(raw: any): { id: string; handle: string } | null {
  const t = raw?.tweet || raw?.status || raw || {};
  const r = t.replying_to ?? t.replyingTo ?? raw?.replying_to ?? raw?.replyingTo;
  if (r && typeof r === "object") {
    const id = String(r.status || r.id || r.status_id || r.tweet_id || "");
    const handle = String(r.screen_name || r.username || r.user_screen_name || "").replace(/^@/, "");
    if (/^\d{2,20}$/.test(id)) return { id, handle };
  }
  const id = String(t.replying_to_status || t.replying_to_status_id || t.in_reply_to_status_id || raw?.replying_to_status || "");
  const handle = String((typeof r === "string" ? r : "") || t.in_reply_to_screen_name || t.replying_to || "").replace(/^@/, "");
  if (/^\d{2,20}$/.test(id)) return { id, handle };
  return null;
}

function mediaCaption(t: any): string {
  const media = t?.media || {};
  const items = [
    ...(Array.isArray(media.photos) ? media.photos : []),
    ...(Array.isArray(media.videos) ? media.videos : []),
    ...(Array.isArray(media.all) ? media.all : []),
    ...(Array.isArray(media) ? media : []),
  ];
  const alts = items.map((i) => i && (i.altText || i.alt || i.description)).filter(Boolean);
  if (alts.length) return alts.join(" ");
  const isVideo = Boolean(media.videos?.length || items.some((i) => i && (i.type === "video" || i.duration)));
  if (isVideo) return "[video]";
  if (items.length) return "[image]";
  return "";
}

function asPost(raw: any, fallbackId: string, fallbackHandle: string): Post | null {
  const t = raw?.tweet || raw?.status || raw;
  if (!t || typeof t !== "object") return null;
  const author = t.author || t.user || {};
  const handle =
    author.screen_name || author.username || t.user_screen_name || fallbackHandle || "";
  const name = author.name || t.user_name || handle;
  const id = String(t.id || t.tweetID || fallbackId || "");
  const text = t.text || t.full_text || t.tweetText || mediaCaption(t) || (id ? "[post]" : "");
  if (!text || !id) return null;
  const q = t.quote || t.quoted_tweet || t.quoted_status || t.qrt || null;
  let quoted: Quoted | null = null;
  if (q && typeof q === "object") {
    const qt = q.text || q.full_text || "";
    const qa = q.author || q.user || {};
    const qh = qa.screen_name || qa.username || q.user_screen_name || "";
    if (qt) quoted = { handle: qh, name: qa.name || qh, text: String(qt) };
  }
  const replyTo = extractReplyTo(raw);
  return {
    id,
    handle: String(handle).replace(/^@/, ""),
    name: String(name),
    text: String(text),
    url: `https://x.com/${String(handle).replace(/^@/, "") || "i"}/status/${id}`,
    quoted,
    parent: null,
    isComment: Boolean(replyTo?.id),
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

async function fetchPostRaw(parsed: { id: string; handle: string; url: string }, timeoutMs = 3500): Promise<{ post: Post; replyTo: { id: string; handle: string } | null } | null> {
  const { id, handle, url } = parsed;
  const fx2 = await getJson(`https://api.fxtwitter.com/2/status/${id}`, timeoutMs);
  let post = asPost(fx2, id, handle);
  if (post) return { post, replyTo: extractReplyTo(fx2) };
  const fx1 = await getJson(`https://api.fxtwitter.com/${handle}/status/${id}`, Math.min(2500, timeoutMs));
  post = asPost(fx1, id, handle);
  if (post) return { post, replyTo: extractReplyTo(fx1) };
  const vx = await getJson(`https://api.vxtwitter.com/${handle}/status/${id}`, Math.min(2500, timeoutMs));
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
      const replyTo = extractReplyTo(vx);
      return {
        post: {
          id: String(vx.tweetID || vx.id || id),
          handle: String(vx.user_screen_name || handle).replace(/^@/, ""),
          name: String(vx.user_name || vx.user_screen_name || handle),
          text: String(text),
          url,
          quoted,
          parent: null,
          isComment: Boolean(replyTo?.id),
        },
        replyTo,
      };
    }
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
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
        return {
          post: { id, handle: h, name: String(o.author_name || h), text, url, quoted: null, parent: null, isComment: false },
          replyTo: null,
        };
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function fetchPost(parsed: { id: string; handle: string; url: string }, withParent = true): Promise<Post | null> {
  const got = await fetchPostRaw(parsed);
  if (!got) return null;
  const { post, replyTo } = got;
  if (withParent && replyTo?.id && replyTo.id !== post.id) {
    post.isComment = true;
    try {
      const parentGot = await fetchPostRaw({
        id: replyTo.id,
        handle: replyTo.handle || "i",
        url: `https://x.com/${replyTo.handle || "i"}/status/${replyTo.id}`,
      }, 2500);
      if (parentGot?.post) {
        const p = parentGot.post;
        post.parent = { id: p.id, handle: p.handle, name: p.name, text: p.text, url: p.url };
      }
    } catch {
      // Parent is context only. Always still reply to the comment itself.
    }
  }
  return post;
}

const POST_TONES: Record<string, string> = {
  joke: "joke",
  win: "win",
  celebration: "win",
  "win/celebration": "win",
  sad: "sad",
  loss: "sad",
  "sad/loss": "sad",
  rant: "rant",
  news: "news",
  question: "question",
  advice: "advice",
  shill: "shill",
  promo: "shill",
  "shill/promo": "shill",
  "hot take": "hot take",
  hottake: "hot take",
  "hot-take": "hot take",
};

function normalizePostTone(raw: string) {
  const key = raw.trim().toLowerCase().replace(/[_]+/g, " ").replace(/\s+/g, " ");
  return POST_TONES[key] || "";
}

function toneHint(mode: string) {
  switch (mode) {
    case "funny":
      return "style override: funnier. still lowercase and deadpan. one line, 5-6 words, no period.";
    case "insightful":
      return "style override: insightful. 1-2 short sentences. add the missed insight.";
    case "supportive":
      return "style override: supportive and warm, not sycophantic. 1-2 short sentences.";
    default:
      return "style: francis. match the classified post tone. exactly 5 or 6 words, one line, no period.";
  }
}

const SYSTEM = `You write a single X reply as Francis (@FrancisJD13).
First classify the post tone as exactly one of: joke, win, sad, rant, news, question, advice, shill, hot take.
Then write one reply that matches that tone:
- joke: play along with the joke
- win: hype or congratulate dryly
- sad: supportive
- rant: agree with a dry twist
- news: quick witty reaction
- question: answer directly
- advice: add one sharp point
- shill: dry and honest, not hype
- hot take: match the energy with a sharper angle, not a plain agree
If a parent post is included, it is context only. Reply directly to the commenter and match the comment's tone, not the parent's.
Hard rules: all lowercase, exactly 5 or 6 words, one line, no period, no hashtags, no brackets, no questions. almost no emojis; 😭 is ok rarely if it fits. plain english, no pidgin; you may lightly mirror the post's energy or slang level but stay in plain english. truthful, no invented facts, names, or numbers. never beg for follows. never just agree. end on a statement.
Return JSON only: {"tone":"...","reply":"..."}`;

function cleanReply(s: string) {
  let t = s.trim().replace(/^["']|["']$/g, "").trim();
  t = t.replace(/#[\w_]+/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.toLowerCase();
  t = t.replace(/[.]+$/g, "").trim();
  return t;
}

async function groqChat(model: string, user: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        temperature: 0.9,
        max_tokens: 256,
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

function extractJson(s: string): any {
  if (!s || typeof s !== "string") return null;
  const cleaned = s.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* continue */ }
  }
  const reply = cleaned.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)"/);
  if (reply) {
    const tone = cleaned.match(/"tone"\s*:\s*"([^"]+)"/);
    return { reply: reply[1], tone: tone ? tone[1] : "" };
  }
  return null;
}

function parseModelReply(raw: string): { reply: string; tone: string } {
  try {
    const d = JSON.parse(raw);
    const msg = d?.choices?.[0]?.message || {};
    const chunks: string[] = [];
    if (typeof msg.content === "string") chunks.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "string") chunks.push(part);
        else if (part && typeof part.text === "string") chunks.push(part.text);
      }
    }
    if (typeof msg.reasoning === "string") chunks.push(msg.reasoning);
    chunks.push(raw);
    for (const chunk of chunks) {
      const o = extractJson(chunk);
      const reply = cleanReply(typeof o?.reply === "string" ? o.reply : "");
      if (reply) {
        return { reply, tone: normalizePostTone(typeof o?.tone === "string" ? o.tone : "") };
      }
    }
    return { reply: "", tone: "" };
  } catch {
    return { reply: "", tone: "" };
  }
}

async function writeWithFallback(user: string): Promise<{ reply: string; tone: string; model: string; usedFallback: boolean; bothRateLimited: boolean }> {
  const attempts: { model: string; fallback: boolean }[] = [
    { model: PRIMARY, fallback: false },
    { model: FALLBACK, fallback: true },
  ];
  let saw429 = 0;
  for (const attempt of attempts) {
    const result = await groqChat(attempt.model, user);
    if (result.status === 429) {
      saw429 += 1;
      continue;
    }
    if (result.status !== 200) continue;
    const parsed = parseModelReply(result.raw);
    if (parsed.reply) {
      return { ...parsed, model: attempt.model, usedFallback: attempt.fallback, bothRateLimited: false };
    }
  }
  return { reply: "", tone: "", model: PRIMARY, usedFallback: true, bothRateLimited: saw429 === attempts.length };
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
  const parentText = typeof body.parentText === "string" ? body.parentText.trim() : "";
  if (urlIn && urlIn.length > URL_MAX) return json({ error: "That link is too long." }, 400);
  if (textIn && textIn.length > TEXT_MAX) return json({ error: "That text is too long. Keep it under 2000 characters." }, 400);
  if (parentText && parentText.length > TEXT_MAX) return json({ error: "That original post text is too long. Keep it under 2000 characters." }, 400);

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
        parent: null,
        isComment: false,
      };
    }
  } else if (textIn) {
    post = { id: "", handle: "", name: "", text: textIn, url: "", quoted: null, parent: null, isComment: false };
  } else {
    return json({ error: "Paste an X post link first." }, 400);
  }
  if (!post) return json({ error: "Couldn't load that post. Paste the text instead.", needsManual: true }, 422);

  if (parentText && !post.parent) {
    post.isComment = true;
    post.parent = { id: "", handle: "", name: "", text: parentText, url: "" };
  }

  let user = "";
  const commentWho = post.name ? `${post.name} (@${post.handle})` : post.handle ? `@${post.handle}` : "a commenter";
  if (post.parent || post.isComment) {
    user = `This is a COMMENT on another post. Reply to the commenter, not the original post.`;
    if (post.parent) {
      const parentWho = post.parent.handle ? `@${post.parent.handle}` : "the original poster";
      user += `\nParent post by ${parentWho}: ${JSON.stringify(post.parent.text)}`;
    }
    user += `\nComment by ${commentWho}: ${JSON.stringify(post.text)}`;
  } else {
    user = `Author: ${post.name ? `${post.name} (@${post.handle})` : post.handle ? `@${post.handle}` : "unknown"}\nPost: ${JSON.stringify(post.text)}`;
  }
  if (post.quoted) user += `\nQuoted post by @${post.quoted.handle}: ${JSON.stringify(post.quoted.text)}`;
  user += `\n${toneHint(tone)}`;
  if (previous) user += `\nDo not repeat this reply: ${JSON.stringify(previous)}`;

  const out = await writeWithFallback(user);
  if (!out.reply && out.bothRateLimited) {
    return json({
      error: "Groq's free limit is used up for now. Try again in a bit.",
      rateLimited: true,
      post,
    }, 429);
  }
  if (!out.reply) return json({ error: "Couldn't write a reply just now. Try again.", post }, 502);
  return json({
    post,
    reply: out.reply,
    detectedTone: out.tone,
    model: out.model,
    usedFallback: out.usedFallback,
  });
};
