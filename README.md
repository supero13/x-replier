# Francis Replies

Paste an X post link and get one reply in Francis's voice. Copy it or open it on X. Nothing posts itself.

Live app: https://francis-replies.vercel.app

## Use it
1. Open the site on your phone (Brave or Chrome).
2. Optionally Install app from the browser menu so it sits on your home screen.
3. Paste an X/Twitter post URL, pick a tone, tap **write a reply**.
4. **copy**, **reply on X**, or **regenerate**.
5. After install, you can Share a post from the X app to Francis Replies; the link fills in automatically.

If a post can't be loaded, paste the text in the box and generate anyway.

## Stack
- Static frontend + one Vercel Function
- Post text from fxtwitter / vxtwitter / Twitter oEmbed (no X API key)
- Replies from Groq's free OpenAI-compatible API

## Models
- Primary: `openai/gpt-oss-120b`
- If that returns 429, falls back to `openai/gpt-oss-20b` and shows a short note
- If both are rate-limited, the app tells you to try again in a bit

`llama-3.3-70b-versatile` and `llama-3.1-8b-instant` were shut down on Groq's free/developer tier on 16 Aug 2026.

Set these as Vercel environment variables (never commit them):

- `LLM_API_KEY`
- `LLM_BASE_URL` (`https://api.groq.com/openai/v1`)
- `LLM_MODEL` (optional)
- `LLM_FALLBACK_MODEL` (optional)
