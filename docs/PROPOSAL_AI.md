# AI Integration Research for Eigen

> Research into local, privacy-preserving AI capabilities that align with Eigen's self-hosted philosophy.

## Why AI Belongs in Eigen

Eigen means "own" — you own your data, your infrastructure, your tools. The mainstream AI landscape is the
opposite: your prompts, documents, and voice go to OpenAI, Google, or Anthropic servers. Every "AI-powered"
feature in Google Workspace or Microsoft 365 feeds user data through cloud inference.

This creates a unique opportunity. Eigen can be the productivity suite where AI features are **as private as the
data they operate on**. No cloud calls. No API keys. No data leaving the user's browser or server. The same
philosophy that drives Eigen's architecture — per-user isolation, local SQLite, self-hosted everything — extends
naturally to AI.

The timing is right: browser-based inference (WebGPU), lightweight open-source models (Qwen, Llama, Phi),
and local TTS/STT have matured to the point where meaningful AI features can run on consumer hardware.

---

## Technology Landscape

### WebLLM — Browser-Side LLM Inference

**Website:** https://webllm.mlc.ai/
**GitHub:** https://github.com/mlc-ai/web-llm
**Package:** `@mlc-ai/web-llm`
**License:** Apache 2.0

WebLLM runs large language models **entirely in the browser** via WebGPU. No server, no API keys, no data
leaves the tab.

**How it works:**
- Models compiled to MLC format (quantized weights + WASM runtime)
- Downloaded from HuggingFace once, cached in browser Cache API or IndexedDB
- Inference runs on the user's GPU via WebGPU
- Web Worker support keeps the UI thread responsive

**Models:** 250+ prebuilt configs across 40+ families. Practical browser models:

| Model | Parameters | VRAM | Good for |
|---|---|---|---|
| SmolLM2-135M | 135M | 359MB | Basic autocomplete, classification |
| Qwen3-0.6B | 0.6B | 1.4GB | Quick summaries, simple Q&A |
| Phi-3-mini | 3.8B | 2.5GB | Writing assistance, reasoning |
| Qwen2.5-3B | 3B | 2.2GB | Translation, drafting |
| Llama-3.2-3B | 3B | 2.9GB | General assistant |

**API:** OpenAI-compatible `chat.completions.create()` with streaming, JSON mode, function calling, and
embeddings.

**Embedding models:** Snowflake Arctic Embed (238MB–1.4GB) for semantic search.

**Browser support:** Chrome/Edge 113+, Safari 26+ (macOS Tahoe), Firefox behind flag. ~83% of desktop users.

**Limitations:**
- First model download is large (hundreds of MB to several GB)
- Performance depends on GPU (integrated GPUs limit model size to ~1-3B)
- No fine-tuning in browser — inference only
- Mobile support is limited

**Verdict:** Perfect philosophical fit. The user's data never leaves their browser. The trade-off is that
browser-viable models are smaller (0.5B–3B) and less capable than server-side alternatives.

---

### Chatterbox — Self-Hosted Text-to-Speech

**Website:** https://www.resemble.ai/chatterbox/
**GitHub:** https://github.com/resemble-ai/chatterbox
**Package:** `pip install chatterbox-tts`
**License:** MIT

Chatterbox is a family of open-source TTS models by Resemble AI that runs entirely on your own hardware.

**Three variants:**

| Model | Params | Languages | Latency | Use case |
|---|---|---|---|---|
| Chatterbox | 500M | English | Standard | Creative speech with emotion control |
| Chatterbox-Turbo | 350M | English | <200ms | Real-time voice agents |
| Chatterbox-Multilingual | 500M | 23 languages | Standard | Global/multilingual |

**Voice cloning:** Provide a ~10-second reference audio clip and Chatterbox clones that voice with zero
fine-tuning. This enables per-user personalized voices.

**Emotion control:** `exaggeration` parameter (0–1) controls emotional intensity. Turbo model supports
paralinguistic tags (`[laugh]`, `[cough]`).

**Languages (multilingual):** Arabic, Chinese, Danish, Dutch, English, Finnish, French, German, Greek, Hebrew,
Hindi, Italian, Japanese, Korean, Malay, Norwegian, Polish, Portuguese, Russian, Spanish, Swedish, Swahili,
Turkish.

**Requirements:** Python, CUDA GPU recommended. Runs as a server-side process — not in the browser.

**Privacy:** Fully local. Audio generation happens on your hardware. Built-in Perth watermarking identifies
AI-generated audio (responsible AI measure).

**Verdict:** Natural fit for a self-hosted suite. Enables accessibility features (read emails aloud, document
narration) and voice interfaces without sending audio to the cloud. Server-side only — would need an API
wrapper to integrate with Eigen's Elysia backend.

---

### Transformers.js — Browser-Side ML Swiss Army Knife

**Docs:** https://huggingface.co/docs/transformers.js
**Package:** `@huggingface/transformers`

Hugging Face's JavaScript port of the Python `transformers` library. Runs in the browser or Node.js/Bun via
ONNX Runtime.

**Supported tasks (500+ model architectures):**
- **Text:** sentiment analysis, NER, summarization, translation, Q&A, embeddings
- **Vision:** image classification, object detection, segmentation, OCR, background removal
- **Audio:** speech-to-text (Whisper), audio classification
- **Multimodal:** image captioning, document Q&A

**Backends:** WASM (CPU, works everywhere) or WebGPU (GPU-accelerated, experimental).

**vs. WebLLM:** WebLLM is optimized for chat/LLM inference. Transformers.js covers a much broader range of
tasks (vision, audio, embeddings, classification) but with smaller models. They are complementary.

**Key advantage for Eigen:** Embeddings. Transformers.js can generate semantic embeddings in the browser,
enabling client-side search without ever sending data to a server.

---

### Whisper Web — Browser-Side Speech-to-Text

Built on Transformers.js. Runs OpenAI's Whisper model in the browser via WASM or WebGPU.

**Models:** whisper-tiny (39M) through whisper-medium (769M) in ONNX format.
**Performance:** Near real-time on modern hardware with tiny/base models and WebGPU.
**Privacy:** Audio never leaves the browser.

---

### Ollama — Server-Side LLM Runtime

**Website:** https://ollama.com
**License:** MIT

"Docker for LLMs." Downloads, manages, and serves open-source models via a REST API on `localhost:11434`.

**Key features:**
- OpenAI-compatible API (`/v1/chat/completions`, `/v1/embeddings`)
- 40,000+ model integrations (Llama 3, Mistral, Gemma, Qwen, DeepSeek, Phi, etc.)
- Streaming, function calling, structured JSON output
- Docker-friendly — runs as a sidecar container
- Apple Metal, NVIDIA CUDA, AMD ROCm support

**For Eigen:** Ollama as an optional sidecar enables server-side AI features with larger, more capable models.
The API server talks to `localhost:11434` — data stays on the same machine. Users who want heavier AI features
can run Ollama alongside Eigen; users who don't simply skip it.

---

## Integration Philosophy

### Core Principles

1. **AI is always optional.** Eigen works perfectly without any AI features. No feature should require AI to
   function. AI enhances existing workflows — it doesn't gate them.

2. **Privacy by architecture.** Browser-side AI (WebLLM, Transformers.js, Whisper) processes data in the user's
   tab. Server-side AI (Ollama, Chatterbox) processes data on the user's server. Nothing leaves the
   infrastructure.

3. **Two tiers, one API.** Browser-side for real-time interactive features (autocomplete, quick summaries).
   Server-side for heavier workloads (document indexing, TTS, embeddings at scale). Both expose the same
   conceptual interface — the app shouldn't care where inference happens.

4. **Progressive enhancement.** Feature detection at runtime: Is WebGPU available? Is a model cached? Is Ollama
   running? Gracefully degrade when capabilities are absent.

5. **User controls the model.** Users choose which models to download, how much VRAM/RAM to allocate, and which
   features to enable. No defaults that silently download gigabytes.

6. **Per-user isolation extends to AI.** Embeddings, conversation history, and model preferences are stored in
   the user's directory (`data/home/{userId}/eigen.ai/`). One user's AI state never leaks to another.

---

## Feature Ideas

### Cross-App: Semantic Search (High Impact)

**The killer feature.** Eigen already has per-user isolated data. Add per-user embedding indexes and users can
search across all their data semantically — "find the email where John mentioned the budget deadline" searches
Mail, Drive, Docs, and Chat simultaneously.

**Architecture:**
- **Browser-side:** Transformers.js or WebLLM with Snowflake Arctic Embed for on-demand queries
- **Server-side:** Ollama `/api/embed` for batch indexing when documents are created/updated
- **Storage:** SQLite table in user's home directory (`eigen.ai/embeddings.db`) with vectors stored as BLOBs
- **Search:** Cosine similarity in SQLite (or a lightweight vector extension like `sqlite-vss`)

**What gets indexed:**
- Email subjects and bodies (Mail)
- Document text content (Docs)
- File names and metadata (Drive)
- Chat messages (Chat)
- Calendar event titles, descriptions, attendees (Calendar)
- Contact names and notes (Contacts)

**Privacy:** Embeddings are generated and stored locally. The index lives in the user's home directory. Search
queries are processed against the local index.

---

### Mail

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Smart compose** | Browser | WebLLM (Qwen/Phi 3B) | Autocomplete suggestions while writing |
| **Quick reply** | Browser | WebLLM | Generate 2-3 reply options from email context |
| **Summarize thread** | Browser | WebLLM | One-paragraph summary of long email threads |
| **Read aloud** | Server | Chatterbox | TTS for email content (accessibility) |
| **Priority inbox** | Server | Ollama + embeddings | Classify emails by urgency/topic |
| **Contact extraction** | Browser | Transformers.js NER | Extract names, emails, phones from signatures |

### Docs

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Writing assistant** | Browser | WebLLM | Inline suggestions, continue writing, rephrase |
| **Grammar check** | Browser | Transformers.js | Lightweight grammar/spelling correction |
| **Summarize** | Browser | WebLLM | Summarize document or selection |
| **Translate** | Browser | Transformers.js (MarianMT) | Translate selected text between languages |
| **Document narration** | Server | Chatterbox | Convert document to audio (podcast-style) |
| **Generate from outline** | Browser | WebLLM | Expand bullet points into prose |

### Calendar

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Smart scheduling** | Server | Ollama | Suggest meeting times based on email context and availability |
| **Meeting prep** | Server | Ollama + embeddings | Before a meeting, gather relevant emails, docs, and contact info |
| **Event from email** | Browser | WebLLM | Parse "Let's meet Tuesday at 3pm" into a calendar event |
| **RSVP summary** | Browser | WebLLM | Summarize attendee responses for large events |

### Drive

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **File content search** | Server | Ollama embeddings | Semantic search across all file contents |
| **Auto-tagging** | Server | Ollama | Suggest tags/folders based on file content |
| **Image captioning** | Browser | Transformers.js (BLIP) | Auto-generate descriptions for uploaded images |
| **OCR** | Browser | Transformers.js | Extract text from images and scanned PDFs |
| **Smart filing** | Server | Ollama + embeddings | Suggest destination folder when uploading |

### Chat

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Translate message** | Browser | Transformers.js | Inline translate a chat message |
| **Summarize thread** | Browser | WebLLM | Catch up on a long conversation |
| **Voice messages** | Both | Whisper (STT) + Chatterbox (TTS) | Record → transcribe, or text → audio |
| **@ai command** | Server | Ollama | Ask the AI assistant in a chat room (MUD-style `/ai question`) |

### Slides

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Generate outline** | Browser | WebLLM | Create slide structure from a topic |
| **Speaker notes** | Browser | WebLLM | Generate speaker notes from slide content |
| **Narrate presentation** | Server | Chatterbox | Auto-narrated slideshows with per-slide TTS |
| **Image suggestions** | Browser | Transformers.js CLIP | Find relevant images from Drive for a slide topic |

### Sheets

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Formula assistant** | Browser | WebLLM | Natural language → formula ("sum of column B where A > 100") |
| **Data summary** | Browser | WebLLM | Describe patterns in selected data |
| **Column classification** | Browser | Transformers.js | Auto-detect data types and suggest formatting |

### Contacts

| Feature | Tier | Technology | Description |
|---|---|---|---|
| **Merge suggestions** | Server | Ollama embeddings | Detect near-duplicate contacts |
| **Enrich from email** | Browser | Transformers.js NER | Extract contact details from email signatures |
| **Relationship context** | Server | Ollama + embeddings | "What's my history with this contact?" across mail/calendar/chat |

---

## Architecture

### Two-Tier Model

```
┌─────────────────────────────────────────────────────┐
│                    BROWSER                           │
│                                                      │
│  WebLLM (chat/completion)    Transformers.js         │
│  ├─ Smart compose            ├─ Embeddings           │
│  ├─ Quick replies            ├─ Translation          │
│  ├─ Summarization            ├─ NER                  │
│  └─ Formula assist           ├─ OCR                  │
│                              ├─ Image captioning     │
│  Whisper Web (STT)           └─ Grammar check        │
│  └─ Voice input / dictation                          │
│                                                      │
├──────────────────────────────────────────────────────┤
│                    EIGEN API SERVER                   │
│                                                      │
│  eigen.ai service (optional)                         │
│  ├─ Embedding index management                       │
│  ├─ Background indexing (on document create/update)  │
│  ├─ Semantic search endpoint                         │
│  └─ TTS endpoint (proxy to Chatterbox)               │
│           │                          │               │
│           ▼                          ▼               │
│     Ollama (sidecar)          Chatterbox (sidecar)   │
│     localhost:11434           localhost:5000          │
│     ├─ /api/chat              ├─ TTS generation      │
│     ├─ /api/embed             └─ Voice cloning       │
│     └─ /api/generate                                 │
│                                                      │
├──────────────────────────────────────────────────────┤
│                    STORAGE (per-user)                 │
│                                                      │
│  data/home/{userId}/eigen.ai/                        │
│  ├─ embeddings.db       (vector index)               │
│  ├─ preferences.json    (model choices, features)    │
│  └─ voices/             (user's voice clones)        │
└──────────────────────────────────────────────────────┘
```

### Data Flow Examples

**Smart compose (browser-only):**
```
User types in Mail composer
  → WebLLM Web Worker receives partial text
  → Model generates completion suggestion
  → UI shows ghost text (Tab to accept)
  → No network request. No data leaves the tab.
```

**Semantic search (server-side):**
```
User saves a document
  → SSE event triggers background indexing
  → API calls Ollama /api/embed with document text
  → Embedding stored in user's eigen.ai/embeddings.db

User searches "budget deadline"
  → Query embedded via Ollama /api/embed (or browser-side Transformers.js)
  → Cosine similarity against eigen.ai/embeddings.db
  → Results returned across Mail, Docs, Drive, Chat, Calendar
```

**Document narration (server-side):**
```
User clicks "Read aloud" on a document
  → API sends text to Chatterbox process
  → Chatterbox generates audio (optionally using user's cloned voice)
  → Audio streamed back to browser
  → All processing on user's server
```

### Integration with Existing Architecture

AI features plug into Eigen's existing patterns:

| Pattern | AI Integration |
|---|---|
| **Home singleton** | `home.ai` service (lazy-initialized, like `home.drive`, `home.calendar`) |
| **Per-user isolation** | AI data in `data/home/{userId}/eigen.ai/` |
| **SSE events** | `ai:index-updated`, `ai:tts-ready` events for real-time feedback |
| **Domain hooks** | `useAI()`, `useSemanticSearch()`, `useTTS()` in `packages/lib/src/core/ai/hooks/` |
| **Routes** | `apps/api/src/routes/ai.ts` for server-side AI endpoints |
| **ManagedDatabase** | `embeddings.db` as a ManagedDatabase with vector tables |

### Browser-Side Architecture

```typescript
// packages/lib/src/core/ai/browser-engine.ts
// Singleton WebLLM engine with lazy initialization

let engine: MLCEngine | null = null;

export async function getEngine(modelId: string, onProgress?: (p: Progress) => void) {
    if (!engine) {
        engine = await CreateWebWorkerMLCEngine(
            new Worker(new URL('./ai-worker.ts', import.meta.url), {type: 'module'}),
            modelId,
            {initProgressCallback: onProgress}
        );
    }
    return engine;
}

// Used by any app:
// const engine = await getEngine('Qwen2.5-3B-Instruct-q4f16_1-MLC');
// const reply = await engine.chat.completions.create({...});
```

### Settings UI Concept

A settings page where users control their AI setup:

```
AI Features (all optional)

Browser AI
├─ Model: [Qwen2.5-3B ▾]     Status: Cached ✓  (2.2 GB)
├─ ☑ Smart compose (Mail, Docs, Chat)
├─ ☑ Quick summaries
├─ ☐ Translation
└─ [Download Model] [Clear Cache]

Server AI
├─ Ollama: [Connected ✓] localhost:11434
│  ├─ Model: [llama3.1:8b ▾]
│  ├─ ☑ Semantic search
│  ├─ ☑ Background indexing
│  └─ ☐ Meeting prep
├─ Chatterbox: [Not configured]
│  ├─ ☐ Read aloud
│  └─ ☐ Document narration
└─ [Test Connection]
```

---

## What Makes This Different

Most "AI-powered" productivity suites route everything through cloud APIs. Eigen's approach would be
fundamentally different:

| | Google Workspace AI | Microsoft Copilot | Eigen AI |
|---|---|---|---|
| **Where inference runs** | Google Cloud | Azure | Your browser + your server |
| **Who sees your data** | Google | Microsoft | Nobody but you |
| **Cost** | $30/user/month | $30/user/month | Free (your hardware) |
| **Model choice** | Gemini (no choice) | GPT-4 (no choice) | User picks model and size |
| **Works offline** | No | No | Yes (browser models cached) |
| **Customizable** | No | No | Fully — swap models, tune params |

This is the same differentiation that drives Eigen overall: sovereignty over convenience.

---

## Implementation Phases

### Phase 0 — Foundation (No AI Yet)

- Add `packages/lib/src/core/ai/` with types, hooks, and feature detection
- Add AI settings page with capability detection (WebGPU? Ollama reachable?)
- Add `eigen.ai/` directory to user home structure
- Define the `AiService` class in `apps/api/src/lib/ai/`

### Phase 1 — Browser-Side Intelligence

**Start with WebLLM because it requires zero server setup.**

- Smart compose in Mail and Docs (WebLLM in Web Worker)
- Quick email reply suggestions
- Summarize selected text anywhere
- Model download/cache management in settings

Why first: lowest barrier to entry. Users download a model in their browser and immediately get value. No Docker
containers, no GPU servers, no configuration.

### Phase 2 — Semantic Search

**The highest-impact server-side feature.**

- Ollama integration as optional sidecar
- Background indexing on document create/update (via SSE event hooks)
- Cross-app semantic search UI in the top bar
- Per-user `embeddings.db` with cosine similarity search

### Phase 3 — Voice & Accessibility

- Whisper Web for browser-side speech-to-text (dictation in Docs, voice search)
- Chatterbox integration for read-aloud (Mail, Docs)
- Voice messages in Chat (record → STT → text, or text → TTS → audio)

### Phase 4 — Deep Integration

- Calendar meeting prep (gather context from Mail, Contacts, Drive)
- Smart filing suggestions in Drive
- Slide generation from outlines
- Formula assistant in Sheets
- `/ai` command in Chat rooms

---

## Risks and Considerations

### Performance
- WebGPU models use significant VRAM. Integrated GPUs (2–4 GB shared) limit model choice.
- Running a 3B model in the browser while editing a collaborative Yjs document may cause memory pressure.
- Ollama models use significant RAM/VRAM on the server. Small VPS instances can't run 7B+ models.

### UX
- Initial model download (1–3 GB) is a significant friction point. Clear progress indication is essential.
- AI response quality from 1–3B browser models is noticeably worse than GPT-4/Claude. Set expectations
  accordingly — "helpful autocomplete" not "AI assistant."
- Features should fail silently or degrade gracefully. A broken AI feature should never block normal work.

### Maintenance
- WebLLM, Transformers.js, and Chatterbox are actively evolving. Model formats and APIs change.
- Ollama compatibility must be tested against each release.
- Model recommendations will change as new models are released.

### Security
- Voice cloning (Chatterbox) could be misused. The built-in watermarking helps but isn't foolproof.
- Prompt injection: if AI features summarize user-generated content (emails from external senders, shared
  documents), adversarial prompts could manipulate output. Treat AI output as untrusted.
- Browser model cache is accessible to browser extensions. This is a browser-level concern, not Eigen-specific.

### Scope
- AI features should enhance, not replace, existing functionality. The core productivity suite must work
  perfectly without AI.
- Avoid the trap of building a chatbot. The most valuable AI features are invisible — autocomplete,
  background indexing, smart defaults — not conversation windows.

---

## Open Questions

1. **Should browser AI models be shared across tabs?** A Service Worker approach persists the model across
   navigations but adds complexity. Web Worker per-tab is simpler but wastes VRAM.

2. **Vector search in SQLite — how?** Options: `sqlite-vss` extension (requires native compilation),
   brute-force cosine similarity on BLOBs (works for small indexes), or a separate vector store.
   Per-user isolation makes indexes small enough that brute-force might suffice.

3. **Ollama vs. embedded inference?** Ollama is the easiest path (Docker sidecar, REST API). But we could
   also explore `node-llama-cpp` or Bun-native inference to avoid the sidecar. Trade-off: simplicity vs.
   dependency count.

4. **Model distribution.** Should Eigen ship with a recommended model list? Or let users bring their own?
   A curated "starter pack" of small, high-quality models (Qwen3-0.6B for quick tasks, Arctic Embed for
   search) would lower the barrier.

5. **How does AI interact with sharing and teams?** If Alice generates a summary of a shared document,
   should that summary be visible to others? Or is AI output always personal? Leaning toward personal-only
   to maintain isolation guarantees.

---

## Conclusion

AI integration in Eigen isn't about competing with Google's Gemini or Microsoft's Copilot on raw capability.
It's about offering AI features that respect the same principles Eigen is built on: you own your data, you
control your tools, nothing leaves your infrastructure.

The most impactful features — semantic search, smart compose, and voice accessibility — can be built with
mature, open-source tools that run locally. Start with browser-side WebLLM (zero infrastructure), grow into
server-side Ollama (for users who want more), and let every feature be optional.

The question isn't whether Eigen should have AI. It's that Eigen is uniquely positioned to offer AI
**the right way**.
