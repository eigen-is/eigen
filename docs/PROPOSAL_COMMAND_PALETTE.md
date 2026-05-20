# Command Palette (⌘K)

> **TLDR**: A single Cmd+K dialog mounted globally in the topbar that unifies **search**,
> **actions**, **navigation**, and **smart suggestions**. Built on a typed result model —
> one variant per kind, no untyped JSON bag. Frontend-only providers (actions, smart-parser,
> contacts) are synchronous over already-cached data; **one** backend call per keystroke
> returns mixed search results. Context-aware via apps publishing their current selection.
> Reuses the already-shipped, currently-unused shadcn `Command` primitive (cmdk). Search is
> served by the FTS5 index from [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md), built as a parallel
> prerequisite track — **not** re-implemented as a throwaway stopgap. The palette's no-backend
> capabilities (actions, navigation, contacts, smart parsing, selection) ship independently
> and don't wait on it. Recents wait for [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md).

## Problem statement

Today the topbar carries only the app switcher, app logo, document title, notification bell,
and avatar — nothing else. Users have no fast way to:

- Find anything that isn't in the current app's visible list
- Take an action that crosses apps ("mail to alice", "share this file with the design team")
- Jump to another app / mailbox / folder / team workspace without clicking through chrome
- Discover what commands exist at all

The contact autosuggest components already prove a typed type-and-pick pattern in this
codebase. The palette scales that proven pattern from one input to one global one.

## Inspirations

| Source              | What we take                                                                                               |
|---------------------|------------------------------------------------------------------------------------------------------------|
| **macOS Spotlight** | Top Hit, sectioned results, parametrised actions (`alice@…` → "Send mail to alice"), tab/space for previews |
| **Raycast**         | Extensible command catalog, sub-action sheet, command keywords/aliases, ranked-by-usage, clipboard actions  |
| **Linear**          | Context-aware commands (in an issue → "Change status" surfaces), prefix filter modes                        |
| **VSCode**          | Prefix scopes (`>` commands, `@` symbols, `:` line)                                                        |
| **Notion**          | One Cmd+P (jump) + Cmd+K (commands) — we collapse to one Cmd+K with sectioned blend                         |
| **iOS Spotlight**   | Detect the *shape* of the input, suggest a tailored action                                                 |

Deliberately avoided:

- Category-first navigation (Alfred-style) — single ranked list with sectioned groups is faster to read
- Native plugins / external processes — must run in-browser as part of Eigen
- Invisible modes — every mode has a visible affordance (prefix in input, scope chip in footer)

## Day-in-the-life

| User intent                  | Keystrokes                   | What surfaces                                          |
|------------------------------|------------------------------|--------------------------------------------------------|
| Mail alice quickly           | `⌘K alice@…` `↵`             | Smart → "Mail to alice@…" → opens Mail compose         |
| Find the Q4 budget           | `⌘K budget` `↵`              | Files → ranked search hits                             |
| Start a new doc here         | `⌘K new doc` `↵`             | Action → "New document" creates in the current folder  |
| Jump to today's calendar     | `⌘K cal today` `↵`           | Navigate → Calendar app, today's view                  |
| Search emails about Q3       | `⌘K mail: q3` `↵`            | Mail-scoped search                                     |
| Share the file I'm viewing   | (file open) `⌘K share` `↵`   | Selection action → Share dialog for that file          |
| Switch to team workspace     | `⌘K team eigen dev` `↵`      | Action → switches owner to the team                    |
| Open a URL pasted in chat    | `⌘K` paste url `↵`           | Smart → "Open link" / "Save link to Drive"             |
| See what's possible now      | `⌘K` (empty)                 | Empty state → curated suggested actions by context     |
| See every command            | `⌘K ?` `↵`                   | Help → full reference                                  |

## Goals

1. **Cmd+K from anywhere** opens one dialog that searches across all Eigen data **and** runs actions
2. **Single input, many intents** — search queries, action verbs, and smart-parsed input
   (`alice@…`, `https://…`) all flow through one field
3. **Context-aware** — current app, current owner, and current selection influence what's surfaced
4. **Keyboard-first** — every result reachable, every action one Enter away, sub-actions one keystroke away
5. **Extensible by typed contribution** — each domain owns one command file; no central registry edits per feature
6. **One backend call per keystroke** — the frontend-only providers are synchronous over in-memory
   data; the only network call is the single search query. No HTTP fan-out per source.
7. **Ships incrementally** — the no-backend palette (actions, navigation, contacts, smart parsing,
   selection) is useful on its own. Search lights up when the search-index track lands; the two
   are decoupled.
8. **Typed end-to-end** — a discriminated union per kind, flowing server → client with no casts and no JSON bags

## Non-goals (v1)

- AI / chat ("ask Eigen anything") — see [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) §Research
- Per-user recents — wait for [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md); no frontend-local placeholder
- Cross-org search — each `Home` is searched independently
- Plugin / extension system — commands are first-party only at v1
- Quicklinks (Raycast-style parametrised URL templates) — defer
- Natural-language datetime parsing, math, unit conversion in the input — risk of a wrong
  suggestion outweighs convenience until telemetry justifies it

The depth of search content (filenames and subjects vs. full document/email bodies) is set by
how far the search-index track has progressed — see [Search](#search). It is not a palette concern.

## UX

### Trigger

- `Mod+K` from anywhere opens the dialog, registered alongside the other global hotkeys.
  `Mod+K` is currently free across the codebase (verified — `Mod+P`, `Mod+B`, `Mod+Z`, `Mod+Y`
  are taken; `K` is not).
- The topbar grows a centred search-pill trigger in its currently-empty centre slot. Click
  opens the dialog. The pill shows the `⌘K` hint.
- `Esc` closes the dialog.

### Layout

```
┌─────────────────────────────────────────────────────────┐
│ 🔍 Search files, jump anywhere, run commands…       esc │
├─────────────────────────────────────────────────────────┤
│ ┃ TOP HIT                                                │
│ ┃ ✉  Mail to alice@example.com                          │
│                                                          │
│ SUGGESTED                                                │
│   📥 Find emails from alice@example.com                 │
│                                                          │
│ ACTIONS                                                  │
│   ✚  New document             ⌘N         Create a doc   │
│   ✚  New spreadsheet                                    │
│   ↥  Upload to current folder                           │
│                                                          │
│ FILES                                                    │
│   ▣  Q4-budget.eigensheets       Eigen Dev / sheets     │
│   📄 Budget review.eigendoc      my docs / drafts       │
│                                                          │
│ CONTACTS                                                 │
│   👤 Alice Smith                  alice@example.com     │
├─────────────────────────────────────────────────────────┤
│ ↑↓ navigate · ↵ open · ⌘↵ new tab · → actions           │
└─────────────────────────────────────────────────────────┘
```

Sections collapse when empty. The Top Hit is the global highest-ranked result above a confidence
threshold. Section order is fixed; order within a section is by final rank.

**Empty state** (no query): the dialog shows a **Suggested** section — a hand-picked static list
of 6–8 universal actions (New doc · Mail · Drive · Calendar · Switch to team · Settings) plus the
current app's top contextual actions. It's not magic — it's a curated array. Per-user ranked
recency arrives when `home.recents` lands.

### Result limits and overflow

Each section caps at **6 results**, ranked. Total visible at full match is roughly 30 rows.
Arrow keys scroll through everything visible; the dialog keeps the focused item in view.

We **do not** show "Show N more" links at v1 — there's nowhere meaningful to navigate to (no app
has a full-search page yet). Users refine the query to narrow, matching Spotlight's behaviour.
When dedicated per-app search pages exist, each section can grow a `↳ Show all N in <App>` footer
that navigates there with the query pre-filled — see open questions.

The reason for caps: stacking 100 rows in a popover degrades fast — keyboard scroll becomes a
chore and the focused item disappears off-screen. Caps plus good ranking keeps the dialog tight.

### Prefix modes

When the query starts with a prefix, the result set scopes:

| Prefix    | Scope                                  |
|-----------|----------------------------------------|
| `>`       | Actions only (VSCode idiom)            |
| `@`       | Contacts / people                      |
| `mail:`   | Mail only                              |
| `file:`   | Files only                             |
| `event:`  | Calendar only                          |
| `chat:`   | Chat messages only                     |
| `?`       | Help — list every command + shortcut   |

No prefix = full blend. The active scope shows as a chip in the footer. Cycling through scopes
needs a key the browser doesn't reserve — **not `Ctrl+Tab`**, which browsers intercept for tab
switching and never deliver to page scripts. Use a plain affordance (e.g. `Tab` to advance the
chip, or click it) instead.

### Sub-action sheet

`→` (primary) or `⌘K` (power-user alias) on a focused result opens a second-level sheet of
actions for that result.

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

Reuses the same `Command` primitive, nested. `Esc` (or `←`) goes back.

## Architecture

### Result model — one typed kind per result

Results are a **discriminated union**, one variant per kind — the same discipline as `SSEvent`,
`HomeMessage`, and the `NotificationCenter`. No JSON payload bag.

| Kind         | Source        | Notes                                                       |
|--------------|---------------|-------------------------------------------------------------|
| `action`     | frontend-only | A catalog command — title, keywords, optional shortcut, run handler, optional availability predicate and sub-actions factory |
| `smart`      | frontend-only | A smart-parsed interpretation of the input (mail-to, open link, …) |
| `contact`    | frontend-only | A person from already-cached contact + team data            |
| `file`       | search wire   | A Drive / docs / sheets / slides / stickies hit             |
| `mail`       | search wire   | An email hit                                                |
| `event`      | search wire   | A calendar event hit                                        |
| `chat`       | search wire   | A chat message hit (once chat content is indexed)           |

Each kind carries a thin **presentation layer** added on the frontend — a stable id, a group, a
rank score, and an icon. Presentation never crosses the wire: an icon is a React component
reference and can't be serialised. The search endpoint emits kind-specific *wire* payloads
(defined once in the shared search types); the palette layers presentation on top before ranking.

Why a union rather than one shape with optional fields: callers (per-kind rows, ranking,
sub-actions) switch on `kind` and the compiler enforces exhaustiveness. The price is one row
component per kind; the payoff is no casts and no runtime shape guards.

Why split wire types from frontend types: the search endpoint stays portable to non-palette
consumers (future per-app search pages), and the non-serialisable presentation bits stay off
the wire.

### Providers

Two kinds of providers feed the engine. **Static providers** are frontend-only — synchronous
over data the frontend already has, no network. **The search provider** is one backend call.
There is no per-source HTTP fan-out.

| Provider   | Kind          | Reads from                                              |
|------------|---------------|---------------------------------------------------------|
| `actions`  | static        | The static command catalog (one file per domain)        |
| `smart`    | static        | The smart-parser (a pure function over the input)       |
| `contacts` | static        | Already-cached contact + team queries                   |
| `search`   | backend call  | The `/search` endpoint — one debounced query            |

The contacts provider lives in the shared lib package and composes the existing contact and
team hooks directly. The contact merge/dedup logic that the autosuggest components already use
should live in the shared lib package so both the autosuggest UI and the palette share one
implementation — move it there if it isn't already. The underlying queries have a session-long
stale time, so typing into the palette never refetches contacts.

### Search

The palette **does not own a search backend**. It consumes one endpoint — `/search/:ownerId`,
described in [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md). That endpoint is backed by per-Home
SQLite FTS5 search indexes that each domain keeps current by indexing on write. It returns
results **grouped by kind** (files, mail, events, and — once chat indexing lands — chats) in a
single call. The exact index storage layout is an open question in PROPOSAL_SEARCH.md and does
not affect the palette.

**Build the search backend as a prerequisite track, not as a phase inside the palette.**
PROPOSAL_SEARCH's first phase (the index schema and service, the metadata indexing hooks for
mail, calendar, and drive, and the search route) plus a one-time backfill of existing data is
everything the palette needs to light up search. That track is independent of the palette's
frontend work and can proceed in parallel with palette Phases 1–5.

**No stopgap.** An earlier draft shipped a throwaway interim — three parallel SQL `LIKE` queries
over filenames, mail subjects, and event titles, to be deleted once the real index landed. That
is cut, for three reasons: it costs about the same to build as the index's first phase; it is
explicitly thrown away afterwards; and a per-Home search index with versioned migrations is a
routine, well-trodden pattern here — there is no migration cost to avoid. Doing it once is
simpler and cheaper. Cutting the stopgap also means **no new search methods on the Drive, Mail,
or Calendar classes** — so none of the Drive layering rules (the SharedDrive wrapper requirement)
come into play. The search route only ever touches a dedicated search index.

**The palette's search provider** is a single debounced query against the endpoint. The input is
debounced before it becomes a query key, and the request forwards an abort signal so a superseded
keystroke's request is genuinely cancelled — not merely ignored after it returns. One network
call per keystroke; every other provider is local.

**Team contexts** work unchanged: the endpoint is owner-scoped, so browsing a team workspace
searches the team's data under the same access checks as the rest of the app.

**Richer results arrive for free.** As PROPOSAL_SEARCH's later phases index document, spreadsheet,
slide, and chat *content* (not just metadata), the same endpoint returns more — the palette's
provider does not change.

### Smart parser

A tiny pure function over the query string, conservative at v1. It recognises two shapes:

- An **email address** → "Mail to …" (opens compose) and "Find emails from …" (opens Mail filtered by sender)
- A **URL** → "Open link" (new tab) and "Save link to Drive"

Each suggestion must navigate to a target that actually exists — "Find emails from …" depends on
the Mail app supporting a sender filter in its URL; confirm that before shipping the suggestion,
or drop it. Patterns explicitly deferred: natural-language datetime, math, currency, unit
conversion. Each adds risk-of-wrong-suggestion that erodes trust faster than its convenience pays
back. Add after telemetry shows demand. Content-aware shapes (image URLs, pasted files) are a
separate later phase — see [Content-aware input](#content-aware-input-later-phase).

### Action catalog

Each domain owns one command file declaring its commands. A command carries a title, keywords,
an optional keyboard shortcut, a run handler, an optional **availability predicate** (gates it by
app, selection, or role), and an optional **sub-actions factory** (builds the second-level sheet
on demand).

Action categories targeted for v1:

| Category      | Examples                                                                                       |
|---------------|------------------------------------------------------------------------------------------------|
| **Create**    | New doc · sheet · slides · stickies · chat · event · contact · folder · upload                 |
| **Compose**   | Mail to … (smart) · Reply to current thread (selection) · Forward (selection)                  |
| **Navigate**  | Go to Mail · Drive · Calendar · Contacts · Stickies · Slides · Sheets · Chat · Space · Settings |
| **Mailbox**   | Inbox · Sent · Drafts · Trash · Archive                                                        |
| **Selection** | Share · Star · Rename · Move · Delete · Copy link · Show in folder · Open in new tab           |
| **Switch**    | Switch to team: <name> · Switch to personal · Open admin (admin only)                          |
| **View**      | Toggle sidebar · Toggle theme · Print                                                          |

Adding a command is a single change touching one domain file. No central registry edits.

### Context publication

The palette needs to know what's currently in focus to surface contextual actions. A small hook
lets a view declare its current selection — an open mail thread, a previewed Drive item, a doc
cursor, a sheet range, a chat message, a calendar event. The selection is **plain typed data** —
a discriminated union of descriptors — so commands can use it in their availability predicates.

It mirrors the ergonomics of the existing preview provider: **a single piece of context state**,
set on mount, cleared on unmount, last writer wins. An earlier draft proposed a *stack* of
selections so nested views (a comment thread inside a sheet) could each contribute. Drop that for
v1: a stack's "deepest wins" semantics depend on React effect ordering, and child effects run
*before* parent effects — which makes the last-registered frame the *shallowest*, not the
deepest. Mirror the preview provider's single nullable state exactly. Revisit a stack only if a
concrete nesting conflict actually appears — consistent with the codebase's bias against
abstractions you don't yet need.

Commands run with a **context object**: the palette context (user, owner, current app, route,
current selection, current folder) plus a small set of side-effect helpers commands need —
navigation, the query client for cache nudges, and a few global operations (create a document,
open the upload dialog, save a link). Bundling them keeps each command file terse.

### Ranking

Search hits arrive pre-sorted by the index's relevance rank; the search provider assigns a base
score by position so the first hit competes with hand-tuned action scores and later hits decay.
Static commands carry their own catalog-authored base score. Final rank combines:

- the base score (search position, or catalog score for static commands)
- a boost when the title **starts with** the query, a smaller boost when it merely **contains** it
- a small boost on a keyword match
- a recency boost (once `home.recents` lands)
- a boost for actions relevant to the current app/selection
- a boost for smart suggestions, so a confident smart parse leads

The Top Hit is the single highest final rank, shown only above a confidence threshold; otherwise
the first row of the highest-ranked section is what the user sees first.

### The engine

One hook merges every provider — the static providers (synchronous) and the single debounced
search call. It parses the query for prefix scopes, applies scope filtering, groups results into
sections, ranks within each section, and picks the Top Hit. The dialog bypasses cmdk's built-in
filter because ranking is already done across heterogeneous typed providers.

**Sections render as soon as their provider resolves; the Top Hit waits.** The static providers
are synchronous, so the Actions, Suggested, and Contacts sections appear the instant the user
types. The search-backed sections (Files, Mail, Events) stream in when the debounced request
returns, a few hundred milliseconds later. The Top Hit is the one result that competes *across*
groups, so it needs the full picture to be correct — computing it from partial data makes the
promoted row flicker as search results land. The engine therefore **holds the Top Hit until the
search request resolves**; the section beneath still shows the result, so nothing feels slow —
only the promoted row settles a beat later. Two cases skip the wait: a deterministic smart-parse
(an email address, a URL) can take the Top Hit immediately, and a query under a prefix scope
that issues no search call has nothing to wait for.

## Content-aware input (later phase)

Today the input reads only text. Two upgrades turn the palette into a clipboard-aware action
launcher — a Raycast-style direction worth taking *after* the core ships.

**1. Image-URL detection.** The smart parser distinguishes an image URL from a plain link (by
extension or known image host). The suggestion is context-dependent:

- In an open document → "Insert image into document"
- In a Drive or docs browser view → "Save image to Drive" (current folder)
- Anywhere → still offers "Open link" / "Save link to Drive"

**2. File paste and drop.** The input accepts pasted or dropped files. The field switches to a
file-action mode (the file shown as a chip), and suggests:

- "Save to Drive" → the current folder, via the existing upload pipeline and quota enforcement
- "Send by mail" → when an email address is also in the input, compose a mail with the file attached

### Two seams these need

- **Acting inside the current app.** "Insert image into the open document" is unlike every v1
  action — v1 actions navigate, open global dialogs, or run global mutations; none reach into a
  live editor. This needs a typed **capability bridge**: an app with a focused editor registers
  an imperative handler ("insert-image") that the palette can invoke. Keep it separate from the
  selection hook — the selection stays pure data (good for availability predicates), capabilities
  are its imperative complement. The save-to-Drive and send-by-mail actions do **not** need this
  bridge — they're global helpers.
- **Carrying binary across navigation.** "Send file by mail" cannot pass a file through a URL.
  Either upload it to Drive first and attach it by reference, or stash the file in a shared
  pending-attachment store the compose view reads. Save-to-Drive has no such issue.

### Considerations

- **Fetching a remote image to save it**: a server-side fetch of an arbitrary user-supplied URL
  is an SSRF surface and must be guarded (block internal addresses and metadata endpoints). A
  client-side fetch avoids SSRF but hits CORS on many image hosts. Decide the strategy — see open
  questions.
- **Quota**: pasted and dropped files go through the same size and quota enforcement as ordinary uploads.
- **Browser support**: pasted *images* are reliable; arbitrary files copied from the OS file
  manager are only partially supported — drag-and-drop onto the palette is the more dependable sibling.
- **Sequencing**: keep the v1 smart parser tiny. The global-helper wins (save image/file to Drive)
  are simpler and come first; the in-editor insert and send-by-mail-with-attachment need the extra
  seams above and come last.

## Topbar trigger

The topbar gets one new element: a centred search pill in its currently-empty centre slot. It
shows a search icon, placeholder text, and the `⌘K` hint; clicking it opens the dialog.

The full pill is too wide for small screens and hides below the mobile breakpoint — but the
palette is a search-first feature, so mobile still needs a **visible** entry point (a compact
search icon button in the topbar), not only `Mod+K` (which needs a keyboard) or a buried menu
item. See open questions.

## UI components

```
packages/ui/src/components/layout/app/command-palette/
  command-palette.tsx            # the dialog — wraps the Command primitive, ranking-controlled
  command-palette-provider.tsx   # context: open/close state, current selection
  command-palette-trigger.tsx    # the topbar pill (and the compact mobile button)
  command-row-*.tsx              # one row component per result kind
  command-footer.tsx             # bottom hint bar
  use-palette-shortcuts.ts       # the Mod+K binding
```

Reuses the **already-shipped, currently-unused** shadcn `Command` primitive (cmdk) — it drives
the dialog, list, keyboard navigation, and empty state out of the box.

## Settings

Settings nest as shallow optional objects, matching the existing pattern. A `commandPalette`
sub-object on user settings gates the feature (default on) and the smart suggestions (default
on). `Mod+K` is hard-coded at v1 — per-user rebinding lands with per-command hotkeys.

## Wiring summary

| Change                                        | Where                                              |
|-----------------------------------------------|----------------------------------------------------|
| Add the command-palette provider to the stack | The app provider stack, alongside the preview provider |
| Register `Mod+K`                              | The global hotkeys component                       |
| Add the search-pill trigger                   | The topbar centre slot                             |

Three integration points make the palette globally available. Everything else is additive —
command files, providers, and row components.

## Why this fits Eigen

- **Typed end-to-end**: the result model is a discriminated union per kind — the same pattern as
  `NotificationCenter`, `SSEvent`, `HomeMessage`. No casts, no JSON payloads.
- **Hooks in the shared lib package**: every data-fetching hook lives where the project rules
  require; the UI consumes typed results only.
- **Reuses existing primitives**: the shadcn `Command` component (already shipped, currently
  unused), the global hotkey hook, the contact-suggestion logic, the API URL helpers.
- **Search via the shared index**: the palette and any future per-app search page consume one
  endpoint backed by one index. The palette does not fork its own search backend.
- **One module per domain**: each app contributes one command file. No central edits per feature.
- **Per-Home model**: the palette honours the owner (personal vs team) so team contexts get team
  data — the same sharding boundary as everything else.
- **Mirrors an existing provider**: open/close and selection state reuse the preview provider's
  plumbing — React context plus a single state value.
- **Familiar keyboard model**: ↑↓ navigate, ↵ select, esc close — carried over unchanged from the
  contact autosuggest the user already knows.

## Phased implementation

| Phase  | Scope                                                                                          | Effort | Depends on            |
|--------|------------------------------------------------------------------------------------------------|--------|-----------------------|
| **Prereq** | Search backend — FTS5 index, metadata indexing hooks, the `/search` route, one-time backfill (PROPOSAL_SEARCH) | M | runs in parallel |
| 1      | Provider wiring, the `Command` primitive in the topbar, the `Mod+K` hotkey, curated empty state | S      | —                     |
| 2      | Static actions catalog (create, navigate, view), per-app command files                          | M      | 1                     |
| 3      | Contacts provider; smart parser for email + URL                                                 | S      | 2                     |
| 4      | Context publication; selection-aware actions across mail / drive / docs / sheets / slides / stickies / chat | M | 2          |
| 5      | Sub-action sheet                                                                                | S      | 4                     |
| 6      | Search provider — consume the `/search` endpoint                                                | S      | 3, Prereq             |
| 7      | Prefix scopes and the help page                                                                 | S      | 5                     |
| 8      | Recents provider — wires to `home.recents`                                                      | S      | PROPOSAL_HOME_RECENTS |
| 9      | Content-aware input — image-URL suggestions and file paste/drop (global-helper actions first, then in-editor insert and send-by-mail) | M | 4, 6 |
| 10     | Smart-parser growth — datetime, math, unit conversion                                           | M      | telemetry             |
| 11     | Pinned commands, per-command hotkeys, aliases                                                   | L      | 10                    |

Phases 1–5 and 7 are a **complete, useful palette with no backend at all** — jumps, creates,
contacts, smart parses, selection actions, prefix scopes. Phase 6 lights up search whenever the
prerequisite track is ready; the two don't block each other. The depth of search results grows
on its own as the search-index track indexes more content — no palette change.

## Open questions

1. **Sub-action key**: `→` as primary, `⌘K` as a power-user alias. `⌘K` alone would mean "the
   same key does different things depending on whether the dialog is open" — not worth the
   overhead. Linear uses `→`; we follow.
2. **Top Hit confidence threshold**: when to *not* show one. Lean: only above a clear rank margin.
3. **Mobile**: the dialog form (full-screen sheet vs. bottom drawer) *and* the entry point. The
   topbar pill hides on small screens, but a search-first feature needs a visible mobile
   affordance — decide on a compact search icon button, don't rely on `Mod+K` and a menu item alone.
4. **Result navigation in a new tab**: `⌘↵` opens a result's URL in a new tab. Actions have no
   URL — decide per-action whether a "new tab" mode applies.
5. **Telemetry**: per-command usage would feed both ranking and product decisions. A recents-style
   table is the clean place for it.
6. **Naming**: "Command palette" reads as VSCode (commands first). For Eigen, search is the
   dominant path. The decision mostly affects the trigger pill's placeholder text — decide before
   launch; "command palette" is fine as the internal name.
7. **Content-aware input — remote-image fetch strategy**: a server-side fetch is an SSRF surface;
   a client-side fetch hits CORS on many hosts. Decide before building "Save image to Drive". And:
   pasting an image URL into the palette competes with pasting it straight into the editor — the
   palette flow must be clearly better (uniformity, discoverability) to justify itself.
8. **Full-page search results**: each section caps at 6, with nowhere to send a user who wants all
   matches until dedicated per-app search pages exist. The current answer is "refine the query";
   per-app search pages are separate work — flagged here.
9. **i18n**: English-only per project scope. Smart-parser verbs stay English; if localisation
   lands later, verbs become a registry.

## File structure

```
packages/lib/src/types/
  command-palette.ts             # the result model, selection + context shapes

packages/lib/src/core/command-palette/
  keys.ts                        # TanStack query keys
  parse-query.ts                 # prefix-scope detection
  smart-parser.ts                # query string → smart suggestions
  rank.ts                        # cross-provider ranking
  commands/                      # one file per domain — drive, mail, calendar, docs,
                                 #   sheets, slides, stickies, chat, contacts, nav, view
  providers/
    actions.ts                   # frontend-only — filters the command catalog
    contacts.ts                  # frontend-only — composes cached contact + team data
    smart.ts                     # frontend-only — smart-parser output
    search.ts                    # the single backend call
    recents.ts                   # wires to home.recents when it lands
  hooks/
    use-command-palette.ts       # open / close
    use-command-results.ts       # the engine — merges providers
    use-palette-selection.ts     # apps publish their current selection

packages/ui/src/components/layout/app/command-palette/
  command-palette.tsx
  command-palette-provider.tsx
  command-palette-trigger.tsx
  command-row-*.tsx
  command-footer.tsx
  use-palette-shortcuts.ts
```

The search index, the `/search` route, the per-domain indexing hooks, and the shared search wire
types are owned by [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md); the palette imports the wire types
and consumes the endpoint.

## Key decisions

- **One backend call per keystroke** — the frontend-only providers (actions, smart, contacts) are
  synchronous over already-cached data; the only network call is the search query. No HTTP
  fan-out per source.
- **No search stopgap** — the palette consumes the shared FTS5 index from PROPOSAL_SEARCH, built
  as a parallel prerequisite track. A throwaway interim (parallel SQL `LIKE` queries) is *not*
  built: it costs the same as the real index's first phase, gets deleted afterwards, and avoids
  no real migration cost. Doing it once is simpler and removes any new search methods from the
  Drive/Mail/Calendar classes.
- **No frontend-local recents** — don't ship what we'll replace. Recents wait for
  PROPOSAL_HOME_RECENTS. The empty state shows curated suggested commands until then.
- **One Cmd+K, not split** — a single dialog with sectioned results is easier to teach than
  Notion's Cmd+P / Cmd+K split; prefix modes recover the precision when wanted.
- **Discriminated union per result kind, not a JSON bag** — matches the `NotificationCenter`,
  `SSEvent`, `HomeMessage` precedent. Compiler-enforced exhaustiveness pays for the per-kind row component.
- **shadcn `Command` primitive** — already shipped, currently unused; a perfect fit. Ranking is
  controlled by the engine, not cmdk's built-in filter.
- **Apps publish selection via a hook** — not via global state inspection. A single state value,
  mirroring the preview provider; no stack until a real nesting conflict demands one.
- **Smart parser starts tiny** — email + URL only. Wrong suggestions erode trust; add patterns
  when usage shows demand. Content-aware input (image URLs, file paste) is a defined later phase.
- **Mod+K is hard-coded** — until per-command hotkeys ship. One thing at a time.
