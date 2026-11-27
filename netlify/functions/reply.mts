const PRIMARY = process.env.LLM_MODEL || "openai/gpt-oss-120b";
const FALLBACK = process.env.LLM_FALLBACK_MODEL || "openai/gpt-oss-20b";
const BASE = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const KEY = process.env.LLM_API_KEY || "";

const URL_MAX = 400;
const TEXT_MAX = 2000;
const BODY_MAX = 4000;
const TONES = new Set(["francis", "supportive", "insights", "naija funny"]);

function normalizeMode(raw: unknown) {
  const k = String(raw || "").trim().toLowerCase().replace(/[_-]+/g, " ");
  if (k === "supportive") return "supportive";
  if (k === "insights" || k === "insightful") return "insights";
  if (k === "naija funny" || k === "naijafunny" || k === "funny") return "naija funny";
  return "francis";
}

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
    case "supportive":
      return "style: supportive. warm personal encouragement aimed at the poster, 3-10 words. cheer them, do not restate the post. no pidgin, no naija, no sarcasm.";
    case "insights":
      return "style: insights. one short smart takeaway or implication the post itself did not say, still grounded only in that post, no new facts or numbers. 3-10 words. no pidgin, no naija. do not reuse the post's wording.";
    case "naija funny":
      return "style: naija funny. light nigerian pidgin humor, positive and on-topic, never mocking. 3-10 words. a funny angle, not a recap, no repeated post wording.";
    default:
      return "style: francis. dry deadpan witty positive one-liner, 3-10 words. a dry witty angle, not a recap. no pidgin, no naija, no sarcasm, no doom.";
  }
}

const SYSTEM = `You write one X reply as Francis (@FrancisJD13), a nigerian crypto guy typing fast on his phone.

Every reply must be positive and encouraging toward the poster. No savage, sarcastic, negative, mocking, or doom lines (bad: "survive or die fr"). Lift the poster up while staying honest.

Stay on topic:
- Reply directly to the exact post text. If this is a COMMENT, reply to the commenter's own words, not a recap of the parent. Parent is background only.
- If a comment is only @mentions or media, you may react to the parent. If the comment has its own message, answer that message.
- Every reply must clearly relate to that text's main point.
- Never introduce topics, coins, numbers, names, or details that are not already in the post (or parent, as background).
- The style examples below are for STYLE only. Never reuse their topics or wording unless the current post is about that.

Voice: all lowercase, casual, human, 3-10 words, one line, no period, no hashtags, no brackets, no questions. abbreviations, dropped words, lol, nah, fr, bro, ngl are fine. 😭 is rare. never invent facts or numbers. never beg for follows. never just agree.

Do not echo or parrot the post. Never reuse the post's content words (bad: post says "tracking" or "survive" or "data" and the reply repeats them). Write a fresh line with new wording.

Add something new: a fresh angle, your own insight, encouragement, or light humor in the requested style, still on-topic and positive. Never invent facts or numbers.

Never use these stock lines: keep grinding, keep tracking, keep pushing, you got this, exciting future, big steps, already winning. Never use hype, hyped, or hyping. Do not repeat any word twice in the reply.

Pidgin and the word "naija" are allowed ONLY in naija funny style. In francis, supportive, and insights, write plain English, no pidgin, no naija.

Banned (AI or empty filler, never use): vibes, vibe, vibing, hype, hyped, hyping, energy, journey, game changer, gamechanger, testament, elevate, unlock, dive, delve, resonate, crucial, seamless, robust, landscape, realm, navigate, leverage, synergy, incredible, amazing, impressive, interesting, insightful, great, great post, love this, spot on, well said, facts, thanks for sharing, appreciate, glad it helped, keep it up, kudos, absolutely, indeed, truly, literally, concise, summary, step forward, this is huge, keep grinding, keep tracking, keep pushing, you got this, exciting future, big steps, already winning. no fire or rocket emoji, no hashtags, no em/en dashes, no semicolons, no comma splicing two polite clauses.

Style examples only (do not copy topics):
- your own vault, no middleman
- finally your own vault on solana
- own vaults, own rules, finally
- verify contracts before trusting any platform
- outflows just mean cheaper sats
- watchlist saves you from chasing
- casual spins turning into real wins
- minting 150 for the community, solid
- happy birthday lekinz
- good morning teaona

First classify the post (or comment) as exactly one of: joke, win, sad, rant, news, question, advice, shill, hot take.
Then write a 3-6 word topic summary of the text you are actually replying to.
Then write one positive reply in the requested style, on that topic, with new wording and a new angle.

Return JSON only: {"tone":"...","topic":"...","reply":"..."}`;

const BANNED_RE = [
  /\bvibes?\b/i,
  /\bvibing\b/i,
  /\benergy\b/i,
  /\bjourney\b/i,
  /\bgame\s*changers?\b/i,
  /\btestament\b/i,
  /\belevate\b/i,
  /\bunlock\b/i,
  /\bdive\b/i,
  /\bdelve\b/i,
  /\bresonate\b/i,
  /\bcrucial\b/i,
  /\bseamless\b/i,
  /\brobust\b/i,
  /\blandscape\b/i,
  /\brealm\b/i,
  /\bnavigate\b/i,
  /\bleverage\b/i,
  /\bsynergy\b/i,
  /\bincredible\b/i,
  /\bamazing\b/i,
  /\bimpressive\b/i,
  /\binteresting\b/i,
  /\binsightful\b/i,
  /\bgreat\b/i,
  /\blove this\b/i,
  /\bspot on\b/i,
  /\bwell said\b/i,
  /\bfacts\b/i,
  /\bthanks for sharing\b/i,
  /\bappreciate\b/i,
  /\bglad it helped\b/i,
  /\bkeep it up\b/i,
  /\bkudos\b/i,
  /\babsolutely\b/i,
  /\bindeed\b/i,
  /\btruly\b/i,
  /\bliterally\b/i,
  /\bconcise\b/i,
  /\bsummary\b/i,
  /\bstep forward\b/i,
  /\bthis is huge\b/i,
  /\bkeep grinding\b/i,
  /\bkeep tracking\b/i,
  /\bkeep pushing\b/i,
  /\byou got this\b/i,
  /\bexciting future\b/i,
  /\bbig steps\b/i,
  /\balready winning\b/i,
  /\bhyp(?:e|ed|ing)\b/i,
  /[🔥🚀]/,
];

const NEGATIVE_RE = [
  /\bor die\b/i,
  /\bdoomed?\b/i,
  /\bcooked\b/i,
  /\byou're finished\b/i,
  /\bshut up\b/i,
  /\bstupid\b/i,
  /\bidiot\b/i,
  /\btrash\b/i,
  /\bgarbage\b/i,
];

const NAIJA_RE = [
  /\bnaija\b/i,
  /\bpidgin\b/i,
  /\be go be\b/i,
  /\babeg\b/i,
  /\bwahala\b/i,
  /\boya\b/i,
  /\bhow far\b/i,
  /\bno be\b/i,
  /\b\w+ dey\b/i,
  /\buna\b/i,
  /\bsha\b/i,
  /\bna so\b/i,
  /\be be\b/i,
  /\bjare\b/i,
  /\bbiko\b/i,
  /\bwetin\b/i,
  /\bcomot\b/i,
  /\bomo\b/i,
];

const STYLE_LEAK = [
  "vault", "vaults", "solana", "middleman", "middlemen", "watchlist", "sats",
  "outflows", "minting", "lekinz", "teaona", "spins", "fbyt", "fbytio",
];

const STOPWORDS = new Set([
  "a","an","the","and","or","but","if","to","of","in","on","for","at","by","is","it","as","be",
  "we","you","your","yours","our","ours","they","them","their","this","that","with","from","are",
  "was","were","been","being","have","has","had","do","does","did","will","would","can","could",
  "should","just","not","no","so","than","then","too","very","also","into","over","after","before",
  "about","up","out","off","its","it's","im","ive","id","ill","dont","cant","wont","youre","youve",
  "youll","thats","theres","heres","whats","whos","lets","like","more","some","only","even","back",
  "here","when","what","which","who","how","why","all","any","each","few","most","other","such",
  "own","same","than","too","via","per","plus","vs","etc","one","two","still","already","now",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9$]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stem(w: string): string {
  let t = w.toLowerCase();
  if (t.length <= 3) return t;
  if (t.endsWith("ies") && t.length > 5) t = t.slice(0, -3) + "y";
  else if (t.endsWith("ing") && t.length > 5) t = t.slice(0, -3);
  else if (t.endsWith("ed") && t.length > 5) t = t.slice(0, -2);
  else if (t.endsWith("es") && t.length > 5) t = t.slice(0, -2);
  else if (t.endsWith("s") && !t.endsWith("ss") && t.length > 4) t = t.slice(0, -1);
  if (t.endsWith("e") && t.length > 5) t = t.slice(0, -1);
  if (t.length > 5 && /(.)\1$/.test(t)) t = t.slice(0, -1);
  return t;
}

function contentWords(s: string): string[] {
  return tokenize(s).filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

function properNouns(s: string): Set<string> {
  const out = new Set<string>();
  const raw = s.replace(/['’]/g, "").split(/[^A-Za-z0-9$-]+/).filter(Boolean);
  for (const tok of raw) {
    const hadDollar = tok.startsWith("$");
    const core = tok.replace(/^\$/, "");
    if (!core || /^\d+$/.test(core)) continue;
    const upper = /^[A-Z0-9-]{2,}$/.test(core) && /[A-Z]/.test(core);
    const named = /[A-Za-z]/.test(core) && /\d/.test(core);
    if (hadDollar || upper || named) {
      const k = core.toLowerCase();
      out.add(k);
      out.add(k.replace(/-/g, ""));
    }
  }
  return out;
}

function repeatedWord(s: string): boolean {
  const seen = new Set<string>();
  for (const w of tokenize(s)) {
    if (seen.has(w)) return true;
    seen.add(w);
  }
  return false;
}

function overlapWords(reply: string, source: string): string[] {
  const sourceStems = new Set(contentWords(source).map(stem));
  const allowed = properNouns(source);
  const replyContent = contentWords(reply);
  const counts = new Map<string, number>();
  for (const w of replyContent) counts.set(w, (counts.get(w) || 0) + 1);
  const hits: string[] = [];
  for (const w of replyContent) {
    if (!sourceStems.has(stem(w))) continue;
    if (allowed.has(w) && (counts.get(w) || 0) <= 1) continue;
    hits.push(w);
  }
  return hits;
}

function looksBanned(s: string, mode = "francis") {
  const t = s.toLowerCase();
  if (BANNED_RE.some((r) => r.test(t))) return true;
  if (NEGATIVE_RE.some((r) => r.test(t))) return true;
  if (/,/.test(t) && /\b(thanks|thank you|appreciate|glad|great|awesome|amazing)\b/.test(t)) return true;
  if (mode !== "naija funny" && NAIJA_RE.some((r) => r.test(t))) return true;
  if (repeatedWord(s)) return true;
  return false;
}

function normalizeHay(s: string) {
  return s.toLowerCase().replace(/[$,]/g, " ").replace(/\s+/g, " ");
}

function offTopic(reply: string, source: string) {
  const hay = normalizeHay(source);
  const compact = hay.replace(/ /g, "");
  const r = reply.toLowerCase();
  for (const m of r.matchAll(/@([a-z0-9_]+)/g)) {
    if (!hay.includes(m[1]) && !hay.includes("@" + m[1])) return true;
  }
  for (const m of r.matchAll(/\$[a-z]{2,15}/g)) {
    const t = m[0].slice(1);
    if (!hay.includes(t) && !hay.includes(m[0])) return true;
  }
  for (const m of r.matchAll(/\$?\d[\d,]*(?:\.\d+)?(?:[kmb])?\b/g)) {
    const n = m[0].replace(/[$,]/g, "").toLowerCase();
    if (!hay.includes(n) && !compact.includes(n)) return true;
  }
  for (const w of STYLE_LEAK) {
    const re = new RegExp(`\\b${w}\\b`, "i");
    if (re.test(r) && !re.test(hay)) return true;
  }
  return false;
}

function cleanReply(s: string) {
  let t = s.trim().replace(/^["']|["']$/g, "").trim();
  t = t.replace(/#[\w_]+/g, "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  t = t.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-");
  t = t.replace(/[\u2018\u2019]/g, "'");
  t = t.replace(/[\u201C\u201D]/g, '"');
  t = t.replace(/\u2026/g, "...");
  t = t.replace(/;/g, ",");
  t = t.replace(/[🔥🚀]/g, "");
  t = t.toLowerCase();
  t = t.replace(/[.]+$/g, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

async function groqChat(model: string, user: string, temperature = 0.7) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        temperature,
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

async function writeWithFallback(user: string, sourceText: string, mode: string): Promise<{ reply: string; tone: string; model: string; usedFallback: boolean; bothRateLimited: boolean }> {
  const attempts: { model: string; fallback: boolean; temperature: number }[] = [
    { model: PRIMARY, fallback: false, temperature: 0.7 },
    { model: PRIMARY, fallback: false, temperature: 0.9 },
    { model: FALLBACK, fallback: true, temperature: 0.85 },
  ];
  const bannedWords = [...new Set(contentWords(sourceText))].slice(0, 40);
  let prompt = user;
  if (bannedWords.length) {
    prompt += `\nDo not reuse any of these words from the post: ${bannedWords.join(", ")}.`;
  }
  type Kept = { reply: string; tone: string; model: string; usedFallback: boolean; overlap: number };
  const kept: Kept[] = [];
  let saw429 = 0;
  let tried = 0;
  for (const attempt of attempts) {
    const result = await groqChat(attempt.model, prompt, attempt.temperature);
    tried += 1;
    if (result.status === 429) {
      saw429 += 1;
      continue;
    }
    if (result.status !== 200) continue;
    const parsed = parseModelReply(result.raw);
    if (!parsed.reply) continue;
    const hits = overlapWords(parsed.reply, sourceText);
    const banned = looksBanned(parsed.reply, mode);
    const off = offTopic(parsed.reply, sourceText);
    if (!banned && !off) {
      kept.push({ ...parsed, model: attempt.model, usedFallback: attempt.fallback, overlap: hits.length });
      if (hits.length === 0) {
        return { reply: parsed.reply, tone: parsed.tone, model: attempt.model, usedFallback: attempt.fallback, bothRateLimited: false };
      }
    }
    if (hits.length) {
      prompt = user + `\nDo not reuse any of these words from the post: ${bannedWords.join(", ")}.\nYour last try repeated: ${[...new Set(hits)].join(", ")}. Write a fresh line with none of those words and no other words from the post.`;
    } else if (banned || off) {
      prompt = user + `\nDo not reuse any of these words from the post: ${bannedWords.join(", ")}.\nYour last try was rejected. Write a fresh on-topic line with new wording, no stock phrases, and no repeated words.`;
    }
  }
  if (kept.length) {
    kept.sort((a, b) => a.overlap - b.overlap);
    const best = kept[0];
    return { reply: best.reply, tone: best.tone, model: best.model, usedFallback: best.usedFallback, bothRateLimited: false };
  }
  return { reply: "", tone: "", model: PRIMARY, usedFallback: true, bothRateLimited: saw429 === tried && tried > 0 };
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
  const tone = normalizeMode(body.tone);
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
    user = `This is a COMMENT. Reply to what the commenter actually said. Do not recap or pitch the parent post.`;
    if (post.parent) {
      const parentWho = post.parent.handle ? `@${post.parent.handle}` : "the original poster";
      user += `\nParent post (background only, not the topic unless the comment has no message of its own) by ${parentWho}: ${JSON.stringify(post.parent.text)}`;
    }
    user += `\nComment to reply to, by ${commentWho}: ${JSON.stringify(post.text)}`;
  } else {
    user = `Author: ${post.name ? `${post.name} (@${post.handle})` : post.handle ? `@${post.handle}` : "unknown"}\nPost to reply to: ${JSON.stringify(post.text)}`;
  }
  if (post.quoted) user += `\nQuoted post by @${post.quoted.handle}: ${JSON.stringify(post.quoted.text)}`;
  user += `\n${toneHint(tone)}`;
  if (previous) user += `\nDo not repeat this reply: ${JSON.stringify(previous)}`;

  const sourceText = [post.text, post.name, post.handle, post.quoted?.text, post.quoted?.handle, post.parent?.text, post.parent?.handle, post.parent?.name].filter(Boolean).join("\n");
  const out = await writeWithFallback(user, sourceText, tone);

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
