const form = document.getElementById("form");
const urlInput = document.getElementById("url");
const go = document.getElementById("go");
const manual = document.getElementById("manual");
const manualText = document.getElementById("manualText");
const parentText = document.getElementById("parentText");
const manualLead = document.getElementById("manualLead");
const commentFlag = document.getElementById("commentFlag");
const parentSnip = document.getElementById("parentSnip");
const preview = document.getElementById("preview");
const previewMeta = document.getElementById("previewMeta");
const previewText = document.getElementById("previewText");
const previewQuote = document.getElementById("previewQuote");
const result = document.getElementById("result");
const replyEl = document.getElementById("reply");
const toneChip = document.getElementById("toneChip");
const modelNote = document.getElementById("modelNote");
const copyBtn = document.getElementById("copy");
const tweetBtn = document.getElementById("tweet");
const regenBtn = document.getElementById("regen");
const errorEl = document.getElementById("error");

let tone = "francis";
let lastReply = "";
let lastPostId = "";

document.querySelectorAll(".tones button").forEach((btn) => {
  btn.addEventListener("click", () => {
    tone = btn.dataset.tone;
    document.querySelectorAll(".tones button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  });
});

function showError(msg) {
  errorEl.hidden = !msg;
  errorEl.textContent = msg || "";
}

function showPost(post) {
  if (!post) {
    preview.hidden = true;
    return;
  }
  preview.hidden = false;
  const isComment = Boolean(post.isComment || post.parent);
  commentFlag.hidden = !isComment;
  if (post.parent && post.parent.text) {
    parentSnip.hidden = false;
    const pWho = post.parent.handle ? `@${post.parent.handle}` : "original post";
    const snip = String(post.parent.text).replace(/\s+/g, " ").trim();
    parentSnip.textContent = `${pWho}: ${snip.length > 180 ? snip.slice(0, 177) + "…" : snip}`;
  } else {
    parentSnip.hidden = true;
    parentSnip.textContent = "";
  }
  const who = post.name && post.handle ? `${post.name} (@${post.handle})` : post.handle ? `@${post.handle}` : "pasted post";
  previewMeta.textContent = who;
  previewText.textContent = post.text || "";
  if (post.quoted && post.quoted.text) {
    previewQuote.hidden = false;
    previewQuote.textContent = `quoting @${post.quoted.handle}: ${post.quoted.text}`;
  } else {
    previewQuote.hidden = true;
    previewQuote.textContent = "";
  }
  if (isComment && !post.parent?.text) {
    manual.hidden = false;
    if (manualLead) manualLead.textContent = "this is a comment. paste the original post too, if you have it.";
  }
}

function showReply(reply, post, usedFallback, model, detectedTone) {
  lastReply = reply;
  lastPostId = post && post.id ? post.id : lastPostId;
  result.hidden = false;
  replyEl.textContent = reply;
  if (detectedTone) {
    toneChip.hidden = false;
    toneChip.textContent = detectedTone;
  } else {
    toneChip.hidden = true;
    toneChip.textContent = "";
  }
  if (usedFallback) {
    modelNote.hidden = false;
    modelNote.textContent = "used the lighter model this time (gpt-oss-20b)";
  } else {
    modelNote.hidden = true;
    modelNote.textContent = "";
  }
  const id = (post && post.id) || lastPostId;
  const intent = new URL("https://x.com/intent/post");
  intent.searchParams.set("text", reply);
  if (id) intent.searchParams.set("in_reply_to", id);
  tweetBtn.href = intent.toString();
}

async function generate(isRegen) {
  showError("");
  const url = urlInput.value.trim();
  const text = manualText.value.trim();
  if (!url && !text) {
    showError("Paste an X post link first.");
    return;
  }
  go.disabled = true;
  regenBtn.disabled = true;
  go.textContent = isRegen ? "writing another…" : "writing…";
  try {
    const r = await fetch("/api/reply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url,
        text: text || undefined,
        parentText: (parentText && parentText.value.trim()) || undefined,
        tone,
        previous: isRegen ? lastReply : undefined,
      }),
    });
    const data = await r.json().catch(() => ({}));
    if (data.post) showPost(data.post);
    if (data.needsManual) manual.hidden = false;
    if (!r.ok) {
      showError(data.error || "Couldn't write a reply just now. Try again.");
      return;
    }
    showReply(data.reply, data.post, data.usedFallback, data.model, data.detectedTone);
  } catch {
    showError("Network error. Check your connection and try again.");
  } finally {
    go.disabled = false;
    regenBtn.disabled = false;
    go.textContent = "write a reply";
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  generate(false);
});
regenBtn.addEventListener("click", () => generate(true));
copyBtn.addEventListener("click", async () => {
  const text = replyEl.textContent || "";
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "copied";
    setTimeout(() => { copyBtn.textContent = "copy"; }, 1200);
  } catch {
    showError("Couldn't copy. Long-press the reply instead.");
  }
});

function extractXUrl(s) {
  if (!s) return "";
  const m = String(s).match(/https?:\/\/(?:www\.|mobile\.)?(?:x\.com|twitter\.com)\/[^\s]+\/status(?:es)?\/\d{2,20}[^\s]*/i);
  return m ? m[0] : "";
}

function applyShareParams() {
  const q = new URLSearchParams(location.search);
  const fromUrl = q.get("url") || "";
  const fromText = q.get("text") || "";
  const fromTitle = q.get("title") || "";
  const found = extractXUrl(fromUrl) || extractXUrl(fromText) || extractXUrl(fromTitle);
  if (found) {
    urlInput.value = found;
    return;
  }
  if (fromText && !fromText.startsWith("http")) {
    manual.hidden = false;
    manualText.value = fromText;
  }
}

applyShareParams();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
