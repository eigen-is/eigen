# Command Palette (⌘K) — remaining work

> **Status — v1 shipped on `main`.** Code in `packages/lib/src/core/command-palette/` +
> `packages/ui/src/components/layout/app/command-palette/`, mounted by `AppShell.PaletteRunner`;
> the shipped design is documented in AGENTS.md § Command palette and in the code itself.
> The palette does jumps, creates, contacts, smart parses (email / URL), selection-aware
> actions, mail / file / in-document / comment / help search, prefix scopes
> (`mail:` / `file:` / `doc:` / `>` / `@` / `?`) and the Tab scope chip. Search depth grows on
> its own as [SEARCH.md](SEARCH.md) indexes more content — document **body**
> hits already flow in through the file provider since the drive content index
> shipped, with zero palette changes.
>
> This document now lists only what's left to build.

| # | Item                                        | Effort | Blocked on                                    |
|---|---------------------------------------------|--------|-----------------------------------------------|
| 1 | Sub-action sheet (`→`)                      | S      | — buildable now                               |
| 2 | `event:` / `chat:` result kinds + prefixes  | S      | SEARCH.md § Remaining (no backend yet)        |
| 3 | Per-user recents                            | S      | PROPOSAL_HOME_RECENTS (still a proposal)      |
| 4 | Content-aware input (paste / drop / image URLs) | M  | — global-helper half buildable now            |
| 5 | Smart-parser growth (datetime, math, units) | M      | telemetry showing demand                      |
| 6 | Pinned commands, per-command hotkeys, aliases | L    | 5 (telemetry)                                 |

AI assist ("ask Eigen anything") stays out of palette scope — see
[SEARCH.md](SEARCH.md).

## 1. Sub-action sheet (`→`)

`→` (primary) or `⌘K` (power-user alias) on a focused result opens a second-level sheet of
actions for that result — find a file and rename it, find a mail and forward it, without
opening it first. `⌘K` alone was rejected as the only trigger: the same key doing different
things depending on whether the dialog is open isn't worth the overhead. Linear uses `→`; we
follow.

```
┌─ Q4-budget.eigensheets ─────────────────────────────────┐
│ 🔍 Actions for this file…                                │
├─────────────────────────────────────────────────────────┤
│   ↗  Open                                                │
│   ↗  Open in new tab                  ⌘↵                │
│   📁 Show in folder                                      │
│   ⭐ Star                                                 │
│   ⚏  Share…                                              │
│   ✏  Rename                                              │
│   ↧  Move                                                │
│   📋 Copy link                                            │
│   ⌫  Delete                                              │
└─────────────────────────────────────────────────────────┘
```

- Reuses the same `Command` primitive, nested. `Esc` (or `←`) goes back.
- The `Command` type gains an optional **sub-actions factory** that builds the second-level
  sheet on demand for the focused result.
- The footer hint bar advertises `→ actions` once it exists.

## 2. `event:` / `chat:` result kinds + prefixes

Blocked: calendar and chat indexing sit in [SEARCH.md](SEARCH.md) § Remaining (calendar
`events_fts`, per-room `messages_fts`), still deferred there — there is no backend to consume.
Once either lands, the palette work mirrors the file kind:

- New `event` / `chat` variants in the `PaletteResult` union, new sections in the engine.
- One provider + one row component per kind.
- `event:` / `chat:` prefixes in `parse-query.ts`, new `PaletteScope` stops in the Tab cycle.

Each is additive and small — richer results per the "arrives for free" design; the palette
never changes for indexing depth, only for new *kinds*.

## 3. Per-user recents

Waits for [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md), which is still a proposal with
no code behind it. No frontend-local placeholder gets built in the meantime (decided — don't
ship what we'll replace). When `home.recents` lands:

- A `recents` provider feeds the empty state, replacing/augmenting the curated static
  Suggested list with per-user ranked recency.
- Action ranking gains its recency boost.

## 4. Content-aware input

Today the input reads only text. Two upgrades turn the palette into a clipboard-aware action
launcher — Raycast-style.

**1. Image-URL detection.** The smart parser distinguishes an image URL from a plain link (by
extension or known image host). The suggestion is context-dependent:

- In an open document → "Insert image into document"
- In a Drive or docs browser view → "Save image to Drive" (current folder)
- Anywhere → still offers "Open link" / "Save link to Drive"

**2. File paste and drop.** The input accepts pasted or dropped files. The field switches to a
file-action mode (the file shown as a chip), and suggests:

- "Save to Drive" → the current folder, via the existing upload pipeline and quota enforcement
- "Send by mail" → when an email address is also in the input, compose a mail with the file attached

The paste/drop wiring should reuse the shared `useFilePasteTarget` / `useFileDropTarget` hooks
in `packages/ui` — the same OS-file attach primitives already used by the mail composer, chat,
cards, and the drive list.

### Two seams these need

- **Acting inside the current app.** "Insert image into the open document" is unlike every
  shipped action — they navigate, open global dialogs, or run global mutations; none reach into
  a live editor. This needs a typed **capability bridge**: an app with a focused editor
  registers an imperative handler ("insert-image") that the palette can invoke. Keep it
  separate from the selection hook — the selection stays pure data (good for availability
  predicates), capabilities are its imperative complement. The save-to-Drive and send-by-mail
  actions do **not** need this bridge — they're global helpers.
- **Carrying binary across navigation.** "Send file by mail" cannot pass a file through a URL.
  Either upload it to Drive first and attach it by reference, or stash the file in a shared
  pending-attachment store the compose view reads. Save-to-Drive has no such issue.

### Considerations

- **Fetching a remote image to save it**: a server-side fetch of an arbitrary user-supplied URL
  is an SSRF surface and must be guarded (block internal addresses and metadata endpoints). A
  client-side fetch avoids SSRF but hits CORS on many image hosts. Decide the strategy — see
  open questions.
- **Quota**: pasted and dropped files go through the same size and quota enforcement as ordinary uploads.
- **Browser support**: pasted *images* are reliable; arbitrary files copied from the OS file
  manager are only partially supported — drag-and-drop onto the palette is the more dependable sibling.
- **Sequencing**: the global-helper wins (save image/file to Drive) are simpler and come first;
  the in-editor insert and send-by-mail-with-attachment need the extra seams above and come last.

## 5. Smart-parser growth

The shipped parser recognises exactly two shapes — an email address and a URL — deliberately.
Every added pattern carries risk-of-wrong-suggestion that erodes trust faster than its
convenience pays back, so growth is gated on telemetry showing demand. Candidates, roughly in
order:

- "Find emails from …" for a matched contact/address (needs a Mail sender-filter URL)
- "Save link to Drive"
- Natural-language datetime → "New event …"
- Math / unit / currency conversion

## 6. Pinned commands, per-command hotkeys, aliases

Raycast-style personalisation: pin favourite commands, bind per-command hotkeys, define
aliases. The `Command` type gains the corresponding fields; `Mod+K` stays hard-coded until
this lands (per-user rebinding is part of it). Depends on the same telemetry as smart-parser
growth — usage data should drive what's worth pinning surface for.

## Cut

- **Per-user `commandPalette` opt-out setting** — cut 2026-07-08. The palette is always on;
  no settings sub-object.

## Open questions

1. **Top Hit confidence threshold**: the *shape* is settled in code (`rank.ts` — promote only
   on a strong structural title match or a deterministic smart-parse, else show no Top Hit).
   What stays open is the exact bar (how strong a prefix/contains match must be), tuned with
   telemetry.
2. **Mobile dialog form**: the entry point is shipped (compact `md:hidden` icon button in the
   topbar); the dialog *form* on small screens is undecided — full-screen sheet vs. bottom drawer.
3. **`⌘↵` new tab as a modifier**: today new-tab exists only as a discrete "Open in new tab"
   command. Whether `⌘↵` on any focused result opens its URL in a new tab — and what it means
   for actions, which have no URL — is undecided.
4. **Telemetry**: per-command usage would feed ranking, the Top-Hit bar, and the phase gates
   for smart-parser growth and pinning. A recents-style table is the clean place for it.
5. **Content-aware remote-image fetch strategy**: server-side fetch is an SSRF surface;
   client-side fetch hits CORS on many hosts. Decide before building "Save image to Drive".
   And: pasting an image URL into the palette competes with pasting it straight into the
   editor — the palette flow must be clearly better (uniformity, discoverability) to justify itself.
6. **Full-page search results**: each palette section caps at 6, with nowhere to send a user
   who wants all matches until dedicated per-app search pages exist. The current answer is
   "refine the query"; per-app search pages are separate work — once they exist, each section
   can grow a `↳ Show all N in <App>` footer that navigates there with the query pre-filled.
