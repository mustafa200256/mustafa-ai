# Mustafa Hussein AI

## Account memory setup

Account registration and long-term memory stay disabled until email delivery and the public site URL are configured. Add these settings to the server environment (for example, Railway Variables); no existing AI key is used for authentication or email:

- `SMTP_HOST`
- `SMTP_PORT` (usually `587`)
- `SMTP_SECURE` (`true` for implicit TLS, otherwise `false`)
- `SMTP_USER`
- `SMTP_PASSWORD`
- `SMTP_FROM`
- `APP_BASE_URL` (the public HTTPS origin, without a path)
- `DATA_DIR` (a persistent writable volume, for example `/data` on Railway)

The application stores accounts, hashed passwords, hashed verification/reset tokens, hashed session tokens, and memories in `mustafa-ai.sqlite` under `DATA_DIR`. Mount durable storage there before enabling registration; the default local `data/` directory is ignored by Git. Use one application instance for a local SQLite data directory.

Users must verify their email before signing in. Passwords are hashed with Node.js scrypt, sessions use `HttpOnly`/`SameSite=Strict` cookies, and memory endpoints derive the user identity from that server-side session rather than a client-supplied ID. Up to 50 short, non-sensitive memories are kept per verified account. Users can review or delete them in the chat UI. Without a signed-in account, explicit memory requests only rely on the current conversation context.

Memories are saved only when the user explicitly asks to remember a fact or states a clear preference. Passwords, API keys, contact details, and other recognized sensitive information are rejected. Relevant memories alone are added to the AI context; starting a new conversation does not delete account memories.

Assistant personalization is available from the chat UI. Signed-in users' validated style, response-length, language, emoji, name, and custom-instruction preferences are saved with their account in the same SQLite database. Anonymous preferences are kept with the current conversation on that device. These preferences affect response style only; custom instructions cannot replace the system prompt or override its safety rules, and credential-like or sensitive custom instructions are rejected.

The image gallery keeps anonymous users' edited images in browser IndexedDB only. Verified accounts can save up to 30 PNG/JPEG/WebP images (8 MiB each) to their account-scoped SQLite gallery; thumbnails are stored separately for fast listing. Account gallery reads and changes are authorized from the existing server-side session, and image bytes are removed when the account owner deletes an image. The configured persistent `DATA_DIR` must have enough capacity for account gallery images.

Conversation search, pinning, and renaming operate locally without sending conversation history to an AI provider. Signed-in accounts use separate browser storage namespaces for their conversation lists; anonymous conversations stay in the existing local browser store.

The chat offers six contextual assistant modes (general, coding, study, writing, analysis, and creative). A mode is stored with its conversation and is validated server-side as additional task guidance; it does not switch the Gemini model or replace system safety instructions. Users can regenerate an assistant reply or edit a prior user message, which truncates later turns and requests a new response with the preceding conversation context. Attachments are retained for retry/edit only for the lifetime of the current browser session; if a saved conversation is reopened after its attachment is no longer available, the text remains editable and the file can be attached again.

Agent Mode is an optional, per-conversation mode that runs through the server-side `/api/agent` endpoint. It accepts only uploaded attachments, a fixed allowlist of existing tools, and a maximum of four tool steps; the server validates the image payload, extracts supported documents, restricts arithmetic to a small parser (no `eval`), and never accepts tool names from the browser. Tool progress is streamed to the chat and the existing stop control cancels provider requests. Google Search Grounding uses the existing Gemini key only on the server and is disabled unless `GOOGLE_SEARCH_GROUNDING_ENABLED=true` is explicitly set. Search failures fall back to a normal Gemini answer. Image analysis/editing use the existing Gemini key on the server; image generation is reported unavailable because this project has no connected generation endpoint. No shell, arbitrary URL, arbitrary code, or database tools are exposed.

Text chat and Agent Mode stream Gemini responses over the existing server-side Gemini integration. When Google Search Grounding is enabled, the chat uses the official Gemini Interactions REST API with `tools: [{ "type": "google_search" }]` and `store: false`; returned citations are shown as links below the answer. The existing GenerateContent streaming path remains in use for ordinary chat. The browser incrementally appends text to the current response bubble and formats Markdown once the response completes. Transient Gemini streaming failures retry at most twice after the first attempt; partial output is reset between attempts. Chat fetch failures can retry before streaming begins, but Agent Mode is never automatically resubmitted after dispatch because its tools may have side effects. Cancelling or losing an Agent Mode connection preserves any final text already received and does not replay tool steps.

**Cost and availability:** Google currently lists Google Search Grounding for Gemini 3.x as unavailable in the free tier. The Paid tier includes 5,000 search requests per month, then lists $14 per 1,000 requests. To avoid unexpected charges, this project does not enable Grounding by default and no environment setting was changed. The UI transparently continues with ordinary Gemini when the server-side opt-in is off or Grounding fails. Only explicitly enable `GOOGLE_SEARCH_GROUNDING_ENABLED=true` after independently confirming the Google project’s access and billing. See [Google’s current pricing](https://ai.google.dev/gemini-api/docs/pricing) and [Google Search Grounding documentation](https://ai.google.dev/gemini-api/docs/google-search).

Voice dictation records locally in the browser, then posts the temporary recording to the server-side `/api/transcribe` endpoint. The server validates the audio type and 8 MiB limit, sends it to the existing `gemini-3.8-flash` model using Gemini's documented audio-input transcription flow and `GEMINI_API_KEY`, and keeps no audio file on disk. Web Speech recognition remains available as a fallback (the user needs to repeat the phrase if server transcription fails). The endpoint accepts WAV, MP3, WebM, OGG, and M4A/MP4 audio. Browser recording stops at two minutes; no transcript is sent as a chat message automatically. Google documents audio transcription on Gemini models that support audio input; `gemini-3.5-transcribe` was not listed in the current official model catalog when this implementation was checked.
