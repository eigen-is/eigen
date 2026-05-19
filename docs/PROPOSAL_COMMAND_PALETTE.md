# Command Palette (⌘K)

> **TLDR**: A single Cmd+K dialog mounted globally in the topbar that unifies **search**, **actions**,
> **navigation**, and **smart suggestions**. Built on a typed `CommandResult` discriminated union
> (one variant per kind, no JSON bag). FE-only providers (actions, smart-parser, contacts from
> the already-cached `useContactSuggestions`) are synchronous; **one** backend call to
> `/search/:ownerId` returns mixed search results per keystroke — no per-source HTTP fan-out.
> Context-aware via apps publishing `usePaletteSelection(...)`. Reuses the already-shipped,
> currently unused shadcn `<Command>` primitive (cmdk). At v1 the backend does **metadata-LIKE
> search** — filenames (`paths.name`), email subjects (`emails.subject`), and event titles
> (`events.title`) — three parallel queries from one route handler, no new index, no migrations.
> Same endpoint URL that [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) — the dedicated **backend**
> proposal — grows into. Recents wait for [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md) —
> no FE-local placeholder.

## Problem statement

Today the topbar is `[AppSwitcher · AppLogo | document title | bell · avatar]` and nothing else
(`packages/ui/src/components/layout/app/topbar.tsx:245-291`). Users have no fast way to:

- Find anything that isn't in the current app's visible list
- Take an action that crosses apps ("mail to alice", "share this file with the design team")
- Jump to another app / mailbox / folder / team workspace without clicking through chrome
- Discover what commands exist at all

Three components already use a typed type-and-pick autosuggest pattern (`ContactAutosuggest`
+ `useContactSuggestions`, `packages/ui/src/components/layout/contacts/`). It's proven; we
need to scale it from one input to one global one.

## Inspirations

| Source                | What we take                                                                                                |
|-----------------------|-------------------------------------------------------------------------------------------------------------|
| **macOS Spotlight**   | Top Hit, sectioned results, parametrised actions (`alice@…` → "Send mail to alice"), tab/space for previews |
| **Raycast**           | Extensible command catalog, sub-action sheet, command keywords/aliases, ranked-by-usage                     |
| **Linear**            | Context-aware commands (in an issue → "Change status" surfaces), prefix filter modes                        |
| **VSCode**            | Prefix scopes (`>` commands, `@` symbols, `:` line)                                                         |
| **Notion**            | One Cmd+P (jump) + Cmd+K (commands) — we collapse to one Cmd+K with sectioned blend                         |
| **iOS Spotlight**     | Detect the *shape* of the input, suggest a tailored action                                                  |

Deliberately avoided:

- Category-first navigation (Alfred-style) — single ranked list with sectioned groups is faster to read
- Native plugins / external processes — must run in-browser as part of Eigen
- Invisible modes — every mode has a visible affordance (prefix in input, scope chip in footer)

## Day-in-the-life

| User intent                                  | Keystrokes                                          | What surfaces                                                |
|----------------------------------------------|-----------------------------------------------------|--------------------------------------------------------------|
| Mail alice quickly                            | `⌘K alice@…` `↵`                                    | Smart → "Mail to alice@…" → opens Mail compose               |
| Find the Q4 budget                            | `⌘K budget` `↵`                                     | Files (filename match at v1; FTS5 body when SEARCH lands)    |
| Start a new doc here                          | `⌘K new doc` `↵`                                    | Action → "New document" creates in `currentFolder`           |
| Jump to today's calendar                      | `⌘K cal today` `↵`                                  | Navigate → Calendar app, today's view                        |
| Search emails about Q3                        | `⌘K mail: q3` `↵`                                   | Mail-scoped subject search (v1); body once SEARCH lands       |
| Share the file I'm viewing                    | (file open) `⌘K share` `↵`                          | Selection action → Share dialog for that file                |
| Switch to team workspace                      | `⌘K team eigen dev` `↵`                             | Action → switches `ownerId` to `team_<id>`                   |
| Open a URL someone pasted in chat             | `⌘K` paste url `↵`                                  | Smart → "Open link" / "Save link to Drive"                   |
| See what's possible right now                  | `⌘K` (empty)                                        | Empty state → curated suggested actions by context           |
| See every command                             | `⌘K ?` `↵`                                          | Help → full reference                                        |

## Goals

1. **Cmd+K from anywhere** opens one dialog that searches across all Eigen data **and** runs actions
2. **Single input, many intents** — search queries, action verbs, and smart-parsed input (`alice@…`, `https://…`) all flow through one field
3. **Context-aware** — current app, current owner, current selection influence what's surfaced and what action verbs do
4. **Keyboard-first** — every result reachable, every action one Enter away, sub-actions one keystroke away
5. **Extensible by typed contribution** — each domain owns one `commands/<domain>.ts` file; no central registry edits per feature
6. **One backend call per keystroke** — FE-only providers (actions, smart, contacts) are synchronous `useMemo` over in-memory data; the only network call is the single `/search/:ownerId` query. No HTTP fan-out per source.
7. **Ships incrementally** — v1 backend search is metadata-LIKE across filenames + email subjects + event titles (no new index, no migrations), at the same URL that PROPOSAL_SEARCH grows into. Recents wait for PROPOSAL_HOME_RECENTS — no localStorage placeholder.
8. **Typed end-to-end** — discriminated union per kind, Elysia → Eden Treaty → hooks → components, no `as any`, no JSON payload bags

## Non-goals (v1)

- AI / chat ("ask Eigen anything") — see [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) §Research
- Per-user recents (action / file / email) — wait for [PROPOSAL_HOME_RECENTS.md](PROPOSAL_HOME_RECENTS.md); no FE-local placeholder
- Full-text search of email **bodies**, document content, chat messages — depends on PROPOSAL_SEARCH; v1 backend is metadata-only (filenames, email subjects, event titles)
- Cross-org search — each `Home` is searched independently
- Plugin / extension system — commands are first-party only at v1
- Quicklinks (Raycast-style parametrised URL templates) — defer
- Natural-language datetime parsing ("tomorrow 3pm") — risk of wrong suggestion outweighs convenience until telemetry justifies it
- Math / calculator / unit conversion in the input — same reason

## UX

### Trigger

- `Mod+K` from anywhere opens the dialog (`useHotkey('Mod+K', …)` in `GlobalHotkeys`,
  `packages/ui/src/components/layout/app/eigen-app.tsx:24-30`). `Mod+K` is currently free across
  the codebase (verified).
- The topbar grows a centred search-pill trigger (the empty slot between AppLogo and the right
  cluster at `topbar.tsx:277-280` is where it lands). Click → opens dialog. Pill shows hint `⌘K`.
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

Sections collapse when empty. The Top Hit is the global max above a confidence threshold (≥ 60).
Section order is fixed; result order within a section is by `final` score.

**Empty state** (no query entered): the dialog shows a **Suggested** section — a hand-picked
static list of 6-8 universal actions (New doc · Mail · Drive · Calendar · Switch to team ·
Settings) plus the current app's top contextual actions. It's not magic — it's a static array
chosen by the team. Per-user ranked recency arrives when `home.recents` lands.

### Result limits and overflow

Each section caps at **6 results**, ranked by `final`. Total visible at full match is ~30 rows
(top hit + 5 sections × 6). Arrow keys scroll through everything visible — cmdk handles overflow
with a soft scroll inside the dialog and keeps the focused item in view.

We **do not** show "Show N more" links at v1 — there's nowhere meaningful to navigate to. Drive
has no full-search page, Mail has no full-search page, etc. Users refine the query to narrow.
This matches Spotlight's behaviour: cap, rely on query refinement, no expansion inside the
dialog.

When PROPOSAL_SEARCH lands and dedicated full-search pages exist per app (Drive search, Mail
advanced search), each section grows a footer item: `↳ Show all 47 results in Drive`. Clicking
it navigates to that app's search page with the query pre-filled. See open question §Full-page
search results.

The reason for caps: stacking 100 rows in a popover degrades fast — keyboard scroll becomes a
chore, the focused item disappears off-screen, the dialog overwhelms the page behind it. Caps +
good ranking keeps the dialog tight and the relevant items in the first viewport.

### Prefix modes

When the query starts with a prefix, the result set scopes:

| Prefix      | Scope                                       |
|-------------|---------------------------------------------|
| `>`         | Actions only (VSCode idiom)                 |
| `@`         | Contacts / people                           |
| `mail:`     | Mail only                                   |
| `file:`     | Files only                                  |
| `event:`    | Calendar only                               |
| `chat:`     | Chat messages only (after SEARCH Phase 2)   |
| `?`         | Help — list every command + shortcut        |

No prefix = full blend. The active scope is shown as a chip in the footer; `Ctrl+Tab` cycles.

### Sub-action sheet

`→` (or `⌘K` while the palette is open) on a focused result opens a second-level cmdk sheet of
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

Following the **typed-table-per-kind** discipline from PROPOSAL_HOME_RECENTS §"One typed table per kind",
results are a **discriminated union** with one variant per kind. Same shape as `SSEvent`, `HomeMessage`,
and the `NotificationCenter`. No JSON payload bag.

```typescript
// packages/lib/src/types/command-palette.ts
import type { LucideIcon } from 'lucide-react';
import type {
    FileSearchHit, MailSearchHit, EventSearchHit, ChatSearchHit,
} from './search';

export type CommandGroup =
    | 'top-hit'
    | 'suggested'         // smart interpretations of the input
    | 'selected-actions'  // actions on the focused result OR app's current selection
    | 'actions'
    | 'files'
    | 'mail'
    | 'contacts'
    | 'events'
    | 'chats'
    | 'recents';

// FE-only presentation fields layered onto every result. Never crosses the wire —
// backends emit kind-specific payload (see types/search.ts) and the palette adds
// these in its provider before ranking.
type Presentation = {
    id: string;
    group: CommandGroup;
    score: number;        // 0..100 — ranked across groups by `final`
    icon: LucideIcon;
};

// Backend-derived kinds: wire SearchHit + FE Presentation. SearchHit defines the `kind`
// discriminator, so a plain `&` here is enough — no redeclaration.
export type FileResult  = FileSearchHit  & Presentation;
export type MailResult  = MailSearchHit  & Presentation;
export type EventResult = EventSearchHit & Presentation;
export type ChatResult  = ChatSearchHit  & Presentation;

// FE-only kinds: actions, smart-parsed suggestions, cached contact suggestions.
export type ActionResult = Presentation & {
    kind: 'action';
    title: string;
    subtitle?: string;
    keywords?: string[];
    shortcut?: string;
    runInNewTab?: boolean;                          // ⌘↵ semantics — see open question 4
    available?: (ctx: ActionContext) => boolean;    // gate by context (app, selection, role)
    action: (ctx: ActionContext) => void | Promise<void>;
    subActions?: (ctx: ActionContext) => ActionResult[];
};

export type ContactResult = Presentation & {
    kind: 'contact';
    displayName: string;
    email: string;
};

export type SmartResult = Presentation & {
    kind: 'smart';
    title: string;
    subtitle?: string;
    action: (ctx: ActionContext) => void | Promise<void>;
};

export type CommandResult =
    | ActionResult | FileResult | MailResult | ContactResult
    | EventResult | ChatResult | SmartResult;
```

Why a union rather than one shape with optional fields: callers (per-kind rows, ranking, sub-actions)
do `switch (r.kind)` and the compiler enforces exhaustiveness. The price is one row component per
kind; the payoff is no `as any` and no runtime shape guards.

Why split wire types from FE types: the search route stays portable to non-palette consumers
(future per-app search pages, an API key client), and `LucideIcon` is a React component reference
that can't be serialised. `Presentation` is the seam.

### Providers

Two kinds of providers feed the engine. **Static providers** are FE-only — synchronous `useMemo`
over data the FE already has, no network. **The search provider** is one backend call. There is
no per-source HTTP fan-out.

#### Static providers (no network)

| Provider     | File                          | Reads from                                  | Phase |
|--------------|-------------------------------|---------------------------------------------|-------|
| `actions`    | `providers/actions.ts`        | Static command catalog (`commands/*.ts`)    | 1     |
| `smart`      | `providers/smart.ts`          | `smart-parser.ts` (pure function on input)  | 3     |
| `contacts`   | `providers/contacts.ts`       | `useContacts()` + `useMyTeams()` (lib hooks) | 3     |

The contacts provider lives in `packages/lib`, so it imports the underlying `useContacts()` and
`useMyTeams()` hooks directly (both are in `packages/lib`); it cannot wrap
`useContactSuggestions`, which is in `packages/ui` and would invert the dep direction. The same
dedup-and-filter pass that `useContactSuggestions` runs gets reused here — extract it to
`packages/lib/src/core/contacts/filter-suggestions.ts` if it doesn't already live in lib.
Either way: the underlying TanStack queries have a session-long `staleTime` and the provider is
a synchronous `useMemo` filter — typing into the palette does not refetch.

#### The search provider (one backend call)

A single endpoint at `/search/:ownerId` returns `SearchResponse = { results: SearchHit[]; total }`
(wire shape from `packages/lib/src/types/search.ts`). The FE provider `&`s `Presentation` per hit
to produce `FileResult | MailResult | EventResult | ChatResult`. One TanStack query per keystroke,
debounced via a `useDebouncedValue` on the input and cancelled on query-key change.

**Backend at v1: metadata-LIKE search across already-SQLite-resident text.** Three small domain
methods queried in parallel from one route handler. No new database, no migrations, no FTS5
index. The columns are already there.

| Domain    | What's searched                                       | New method                                        |
|-----------|-------------------------------------------------------|---------------------------------------------------|
| Drive     | `paths.name` across the user's mounts                 | `Drive.searchByName(q, {limit})`                  |
| Mail      | `emails.subject` (+ optionally `fromShort`)           | `MailDB.searchSubjects(q, {limit})` — exposed via `home.mail.searchSubjects()` (Maildir delegates to its `db`) |
| Calendar  | `events.title` (+ optionally `location`)              | `Calendar.searchEvents(q, {limit})`               |

Contacts is **not** here — `useContactSuggestions` is already cached FE-side, so the contacts
provider filters synchronously without a backend hit.

```typescript
// apps/api/src/routes/search.ts (new)
.get('/search/:ownerId', async ({params, query, user}) => {
    const parsed = parseOwnerId(params.ownerId);
    if (parsed.type === 'user') requireSelf(params.ownerId, user.id);
    else if (parsed.type === 'team') await requireTeamAccess(user.id, parsed.id);
    const home = await getHome(params.ownerId);
    const limit = Math.min(Number(query.limit ?? 20), 100);
    const [files, mail, events] = await Promise.all([
        home.drive.searchByName(query.q, { limit }),
        home.mail.searchSubjects(query.q, { limit }),
        home.calendar.searchEvents(query.q, { limit }),
    ]);
    return {
        results: [...files, ...mail, ...events],
        total: files.length + mail.length + events.length,
    };
}, { auth: true });

// apps/api/src/lib/drive/drive.ts (new method) — returns the wire type, not the
// FE FileResult. The palette adds Presentation on top.
async searchByName(q: string, { limit }: { limit: number }): Promise<FileSearchHit[]> {
    if (!q.trim()) return [];
    const pattern = `%${escapeLike(q)}%`;
    const out: FileSearchHit[] = [];
    // Drive composes Mount instances internally; iterate via its existing accessor.
    for (const mount of this.mounts()) {
        const rows = await mount.db.select().from(paths)
            .where(like(paths.name, pattern))
            .limit(limit)
            .all();
        for (const r of rows) out.push(toFileSearchHit(r, mount.id, this.ownerId));
    }
    return out.slice(0, limit);
}
```

`LIKE %q%` doesn't benefit from a B-tree index, but each table has well under 10k rows for
typical users — SQLite handles it in single-digit milliseconds. Three parallel queries within one
route handler add no meaningful latency.

When PROPOSAL_SEARCH lands, the route body swaps to `home.searchIndex.query(...)` — one DB query
against the unified FTS5 index instead of three per-domain `LIKE`s. **Same URL, same response
shape.** The FE provider doesn't change.

When the user is browsing a team workspace (`ownerId = team_{id}`), the team's `Home` is queried,
so the same endpoint searches team data. Standard `requireTeamAccess` gate.

### Smart parser

Tiny pure function on the query string. Conservative at v1.

```typescript
// packages/lib/src/core/command-palette/smart-parser.ts
const EMAIL = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/i;
const URL_ = /^https?:\/\/\S+$/i;

export function parseSmart(q: string, ctx: PaletteContext): SmartResult[] {
    const out: SmartResult[] = [];

    if (EMAIL.test(q)) {
        const email = q.toLowerCase();
        out.push({
            kind: 'smart', id: 'mail-to', group: 'suggested', score: 100, icon: Mail,
            title: `Mail to ${email}`,
            action: ({ navigate }) => navigate(getMailComposeUrl(email)),
        });
        out.push({
            kind: 'smart', id: 'find-from', group: 'suggested', score: 92, icon: Inbox,
            title: `Find emails from ${email}`,
            action: ({ navigate }) => navigate(`${getMailAppUrl()}?from=${encodeURIComponent(email)}`),
        });
    } else if (URL_.test(q)) {
        out.push({
            kind: 'smart', id: 'open-url', group: 'suggested', score: 100, icon: ExternalLink,
            title: 'Open link',
            action: () => window.open(q, '_blank', 'noopener'),
        });
        out.push({
            kind: 'smart', id: 'save-link', group: 'suggested', score: 88, icon: BookmarkPlus,
            title: 'Save link to Drive',
            action: ({ saveLink }) => saveLink(q),
        });
    }

    return out;
}
```

Patterns explicitly deferred: natural-language datetime, math, currency, unit conversion. Each adds
risk-of-wrong-suggestion that erodes trust faster than its convenience pays back. Add after telemetry
shows demand.

### Action catalog

Each domain owns one TypeScript file declaring its commands. `available(ctx)` gates them; an optional
`subActions(ctx)` factory builds the second-level sheet on demand.

```typescript
// packages/lib/src/core/command-palette/commands/drive.ts
import { FileText, Upload } from 'lucide-react';

export const driveCommands: ActionResult[] = [
    {
        kind: 'action', id: 'drive.new-doc', group: 'actions', score: 80,
        icon: FileText,
        title: 'New document',
        subtitle: 'Create a doc in the current folder',
        keywords: ['create', 'doc', 'write'],
        action: ({ createEigenDoc, currentFolder }) => createEigenDoc(currentFolder),
    },
    {
        kind: 'action', id: 'drive.upload', group: 'actions', score: 75,
        icon: Upload,
        title: 'Upload files',
        keywords: ['attach', 'add', 'file'],
        action: ({ openUploadDialog }) => openUploadDialog(),
        available: ctx => ctx.app === 'drive',
    },
    // … new sheet / slides / stickies / chat / folder
];
```

Action categories targeted for v1:

| Category      | Examples                                                                                       |
|---------------|------------------------------------------------------------------------------------------------|
| **Create**    | New doc · sheet · slides · stickies · chat · event · contact · folder · upload                 |
| **Compose**   | Mail to … (smart) · Reply to current thread (selection) · Forward (selection)                  |
| **Navigate**  | Go to Mail · Drive · Calendar · Contacts · Stickies · Slides · Sheets · Chat · Space · Settings |
| **Mailbox**   | Inbox · Sent · Drafts · Trash · Archive (route to `box/<name>`)                                |
| **Selection** | Share · Star · Rename · Move · Delete · Copy link · Show in folder · Open in new tab           |
| **Switch**    | Switch to team: <name> · Switch to personal · Open admin (admin only)                          |
| **View**      | Toggle sidebar · Toggle theme · Print                                                          |

Every command lives in `packages/lib/src/core/command-palette/commands/<domain>.ts`. Adding one is a
single PR touching one file.

### Context publication

The palette needs to know what's currently visible to surface contextual actions. Apps publish
their current selection imperatively via a hook that mirrors the `usePreview` ergonomics
(`packages/ui/src/components/layout/preview-provider/preview-provider.tsx`) — but with stack
semantics (see below) because selections nest.

```typescript
// In MailThreadView
function MailThreadView({ threadId, mailbox }: Props) {
    usePaletteSelection({ kind: 'mail-thread', threadId, mailbox });
    // …
}

// In FilePreview
usePaletteSelection({ kind: 'drive-item', ownerId, mountId, pathId, mimeType });
```

`usePaletteSelection` pushes a frame onto a context-scoped stack on mount and pops it on unmount
— the deepest mount wins. This is a new pattern (one we own, not inherited): `PreviewProvider`
uses a single `useState<PreviewState | null>` setter — only one preview at a time. Selection
nests (a comment thread inside a sheet inside an app), so we need a stack. Plain React context +
`useState<PaletteSelection[]>`; no Zustand.

```typescript
export type PaletteContext = {
    user: AuthUser;
    ownerId: string;
    app: AppName;
    route: string;
    selection?: PaletteSelection;
    currentFolder?: { ownerId: string; mountId: string; pathId: string };
};

export type PaletteSelection =
    | { kind: 'mail-thread'; threadId: string; mailbox: string }
    | { kind: 'drive-item'; ownerId: string; mountId: string; pathId: string; mimeType: string }
    | { kind: 'doc-cursor'; ownerId: string; mountId: string; pathId: string }
    | { kind: 'sheet-range'; ownerId: string; mountId: string; pathId: string; range: string }
    | { kind: 'chat-message'; ownerId: string; mountId: string; chatId: string; messageId: string }
    | { kind: 'calendar-event'; eventId: string };

// ActionContext = PaletteContext + the side-effect helpers commands need to actually run.
// Bundled here so individual command files (commands/<domain>.ts) stay terse and don't each
// import the same handful of API helpers.
export type ActionContext = PaletteContext & {
    navigate: (url: string) => void;       // wraps router.navigate; `runInNewTab` honours ⌘↵
    queryClient: QueryClient;              // for cache nudges after an action
    createEigenDoc: (folder: { ownerId: string; mountId: string; pathId: string }) => Promise<void>;
    openUploadDialog: () => void;
    saveLink: (url: string) => Promise<void>;
};
```

### Ranking

Search hits arrive **pre-sorted by `bm25(search_fts)`** (most relevant first; cf.
[PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md) `SearchIndex.query`). The FE provider assigns
`baseScore = 80 - i * 5` by position — first hit competes with hand-tuned action scores,
later hits decay. Static commands (actions, smart, contact) carry their own `score` from the
catalog. Final rank per result:

```text
final = baseScore
      + (titleStartsWithQuery ? 30 : 0)
      + (titleContainsQuery   ? 10 : 0)
      + (keywordMatch         ?  8 : 0)
      + recencyBoost(useCount, daysSinceLastUse)   // 0..20 from home.recents
      + (commandIsContextual(ctx) ? 15 : 0)        // boosts current-app actions
      + (group === 'suggested'    ? 12 : 0)        // smart parses lead
```

Top Hit is `max(final)` if ≥ 60. Otherwise no Top Hit row — the highest match in its own section
is the first thing the user sees.

### The engine

One hook merges every provider. Four inputs, **one** network call.

```typescript
// packages/lib/src/core/command-palette/hooks/use-command-results.ts
export function useCommandResults(query: string, ctx: PaletteContext) {
    const parsed = useMemo(() => parseQuery(query), [query]);

    // Static providers — synchronous useMemo, no network
    const actions  = useActionResults(parsed, ctx);
    const smart    = useSmartResults(parsed, ctx);
    const contacts = useContactResults(parsed, ctx); // composes useContacts() + useMyTeams() (already cached)

    // The single backend call. useSearch debounces internally via useDebouncedValue on `parsed.q`;
    // TanStack Query cancels in-flight requests when the (debounced) query key changes.
    const { data: search = [], isLoading } = useSearch(parsed, ctx);

    return useMemo(
        () => ({ ...mergeAndRank({ actions, smart, contacts, search }, parsed, ctx), isLoading }),
        [actions, smart, contacts, search, parsed, ctx, isLoading],
    );
}
```

`mergeAndRank` applies scope filtering (if a prefix is active), groups by `group`, sorts by `final`,
and picks the Top Hit. Returns `{ topHit, sections, isLoading }`.

The dialog wraps `<Command shouldFilter={false}>` — cmdk's built-in filter is bypassed because we
already ranked across heterogeneous typed providers.

## Topbar trigger

The topbar gets one new element: a centred pill in the empty slot at `topbar.tsx:277-280`.

```tsx
<button
    onClick={() => commandPalette.open()}
    className="bg-app-foreground/5 hover:bg-app-foreground/10 text-app-foreground/70
               h-8 max-w-md w-full rounded-md px-3 flex items-center gap-2"
>
    <Search className="h-4 w-4" />
    <span className="flex-1 text-left text-sm">Search files, people, or jump anywhere…</span>
    <kbd className="text-xs">⌘K</kbd>
</button>
```

Hidden on mobile (the search input is too small below ~640px). Mobile users open the palette from
the AppSwitcher dropdown or via `Mod+K` on an attached keyboard.

## UI components

```
packages/ui/src/components/layout/app/command-palette/
  command-palette.tsx            # the dialog — wraps <CommandDialog> with shouldFilter={false}
  command-palette-provider.tsx   # context: open/close, selection stack
  command-palette-trigger.tsx    # the topbar pill
  command-row-action.tsx         # one row component per kind — switch (r.kind) at the engine
  command-row-file.tsx           # so each row is concrete-typed
  command-row-mail.tsx
  command-row-contact.tsx
  command-row-event.tsx
  command-row-chat.tsx
  command-row-smart.tsx
  command-footer.tsx             # bottom hint bar
  use-palette-shortcuts.ts       # Mod+K binding; mounted inside GlobalHotkeys
```

Reuses the **already-shipped, currently-unused** shadcn primitive at
`packages/ui/src/components/command.tsx` (exports: `Command`, `CommandDialog`, `CommandInput`,
`CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`, `CommandSeparator`, `CommandShortcut`).
Drives the dialog, list, keyboard navigation, and empty state out of the box.

## Settings

Per project memory, settings nest as shallow optional objects (`packages/lib/src/types/settings.ts`).

```typescript
type UserSettings = {
    theme?: ...;
    mounts?: ...;
    email?: ...;
    commandPalette?: {
        enabled?: boolean;         // default true
        smartSuggestions?: boolean; // default true (gates smart-parser output)
    };
};
```

Mod+K is hard-coded at v1 — per-user rebinding lands with per-command hotkeys (Phase 11).

## Wiring summary

| Change                                            | File                                                                  |
|---------------------------------------------------|-----------------------------------------------------------------------|
| Add `CommandPaletteProvider` to the stack         | `packages/ui/src/components/layout/app/eigen-app.tsx:54` (alongside `PreviewProvider`) |
| Register `Mod+K` in `GlobalHotkeys`               | `packages/ui/src/components/layout/app/eigen-app.tsx:24-30`           |
| Add `<CommandPaletteTrigger />` to the topbar     | `packages/ui/src/components/layout/app/topbar.tsx:277` (centre slot)  |

Three file edits to make the palette globally available. Everything else is additive
(`commands/<domain>.ts`, `sources/<source>.ts`, row components).

## Why this fits Eigen

- **Typed end-to-end**: `CommandResult` is a discriminated union per kind — same pattern as
  `NotificationCenter`, `SSEvent`, `HomeMessage`. Eden Treaty surfaces server results with concrete
  types. No `as any`, no JSON payloads.
- **Hooks in `packages/lib`**: every data-fetching hook lives where AGENTS.md requires; UI consumes
  typed results only.
- **Reuses existing primitives**: shadcn `<Command>` (already shipped), `useHotkey`,
  `useContactSuggestions`, the URL helpers in `packages/lib/src/core/api.ts`.
- **Doesn't block on proposals**: v1 backend is metadata-LIKE across already-resident SQLite
  columns (filenames, mail subjects, event titles) — no new database, no FTS5, no migrations.
  Same endpoint URL that PROPOSAL_SEARCH grows into; when richer search lands the FE provider
  doesn't change.
- **One module per domain**: each app contributes one `commands/<domain>.ts` file. No central
  edits per feature.
- **Per-Home model**: the palette honours `ownerId` (personal vs team) so team contexts get team
  data — same sharding boundary as everything else.
- **Provider-stack pattern**: `CommandPaletteProvider` reuses `PreviewProvider`'s plumbing
  (React context + `useState`, conditional render) for open/close state. Selection nests, so
  `usePaletteSelection` adds a `useState<PaletteSelection[]>` stack on top — that part is new.
- **Match cmdk to existing autosuggest UX**: the keyboard model the user already knows from
  `ContactAutosuggest` (↑↓ navigate, ↵ select, esc close) carries over unchanged.

## Phased implementation

| Phase | Scope                                                                                                              | Effort | Depends on               |
|-------|--------------------------------------------------------------------------------------------------------------------|--------|--------------------------|
| 1     | Provider wiring, `Command` primitive in topbar, Mod+K hotkey, empty-state = curated suggested commands             | S      | —                        |
| 2     | Static actions catalog (create, navigate, view), per-app `commands/` files, `actions` provider                     | M      | Phase 1                  |
| 3     | Contacts provider via `useContactSuggestions`; smart-parser for email + URL                                        | S      | Phase 2                  |
| 4     | Context publication (`usePaletteSelection`); selection-aware actions for mail / drive / docs / sheets / slides / stickies / chat | M      | Phase 2                  |
| 5     | Sub-action sheet (`→` / `⌘K` on focused result)                                                                    | S      | Phase 4                  |
| 6     | Backend `/search/:ownerId` — `Drive.searchByName` + `MailDB.searchSubjects` (via `home.mail`) + `Calendar.searchEvents` (parallel `LIKE`); FE `search` provider | M | Phase 3 |
| 7     | Prefix scopes (`>`, `@`, `mail:`, `file:`, `event:`, `chat:`); help page (`?`)                                     | S      | Phase 5                  |
| 8     | Recents provider — wires to `home.recents` once it lands                                                           | S      | PROPOSAL_HOME_RECENTS    |
| 9     | Backend grows: `home.searchIndex` replaces the three parallel `LIKE`s with one FTS5 query — adds full mail bodies, contacts data field, doc/sheet/slide/stickies/chat content via Yjs extraction. FE provider unchanged. | L | PROPOSAL_SEARCH |
| 10    | Smart-parser growth: datetime → "Create event", math → calculator, unit conversion                                 | M      | Phase 9 (telemetry)      |
| 11    | Pinned commands, per-command hotkeys, aliases (Quicklinks)                                                         | L      | Phase 10                 |

Phase 1-7 is a *complete* palette without depending on either proposal: jumps, creates, contacts,
smart parses, metadata search (filenames + mail subjects + event titles), selection actions,
prefix scopes. Phase 8 wires recents when PROPOSAL_HOME_RECENTS ships. Phase 9 swaps to FTS5 +
body content when PROPOSAL_SEARCH ships. Same `/search/:ownerId` URL, same response shape, same
FE provider — only the route body changes.

## Open questions

1. **Sub-action key**: `→` (primary) with Cmd+K as a power-user alias. Cmd+K alone would mean
   "same key does different things depending on whether the dialog is open" — cognitive overhead
   not worth it. Linear uses →; we follow.

2. **Top Hit confidence threshold**: when to *not* show one. Linear always shows it; Spotlight
   sometimes doesn't. Lean: only when `final ≥ 60`.

3. **Mobile**: full-screen sheet vs bottom drawer. cmdk supports both. The topbar pill hides below
   ~640px; the palette opens via Mod+K (Bluetooth keyboard) or the AppSwitcher menu.

4. **Result navigation in new tab**: `Cmd+Enter` opens the result's URL in a new tab. Action results
   have no URL — disable, or run the action in a "new tab" mode where applicable? Decide per-action
   via `Result.runInNewTab`.

5. **Telemetry**: per-command usage would feed ranking *and* product decisions. A `command_recents`
   table mirrors the existing two kinds in PROPOSAL_HOME_RECENTS cleanly.

6. **Indexing chat content**: PROPOSAL_SEARCH Phase 2 indexes chat messages. Until that's done,
   `chat:` scope falls back to room titles only (queryable via Drive metadata). Acceptable degradation.

7. **Search response shape — RESOLVED**: the wire returns `SearchResponse = { results: SearchHit[];
   total }`, with `SearchHit = FileSearchHit | MailSearchHit | EventSearchHit | ChatSearchHit`
   defined in `packages/lib/src/types/search.ts` (shared with
   [PROPOSAL_SEARCH.md](PROPOSAL_SEARCH.md)). The v1 stopgap emits the first three variants;
   PROPOSAL_SEARCH Phase 2 (chat indexing) starts emitting `ChatSearchHit`. The FE projects
   `SearchHit` → `CommandResult` by `&`-ing on `Presentation` (`id` / `group` / `score` / `icon`)
   — non-serialisable bits stay off the wire.

8. **Full-page search results**: the palette caps each section at 6. When a user wants to see *all*
   matches, there's nowhere to send them at v1 (Drive has no search page, Mail has no advanced
   search). The current answer is "refine the query." When PROPOSAL_SEARCH lands and dedicated
   per-app search pages exist, each section grows a footer `↳ Show all N in <App>` that navigates
   there with the query pre-filled. The search pages are separate work — flag now.

9. **Naming honesty**: "Command palette" reads as VSCode (commands first). For Eigen, search is
   the dominant use case — typing a query and hitting Enter is the 80% path. *Quick Find*,
   *Spotlight*, or just *Search* might be more honest. The decision affects the trigger pill's
   placeholder text more than the architecture; decide before launch.

10. **i18n**: English-only per project memory. Smart-parser verbs (`mail to`, `find emails from`)
    stay English. If localisation lands later, verbs become a registry.

## File structure

```
apps/api/src/routes/
  search.ts                        # phase 6 — /search/:ownerId (3 parallel LIKEs at v1; FTS5 once PROPOSAL_SEARCH ships)

apps/api/src/lib/drive/
  drive.ts                         # phase 6 — adds Drive.searchByName(q, {limit})

apps/api/src/lib/mail/
  maildb.ts                        # phase 6 — adds MailDB.searchSubjects(q, {limit})
  maildir.ts                       # phase 6 — exposes home.mail.searchSubjects() that delegates to this.db

apps/api/src/lib/calendar/
  calendar.ts                      # phase 6 — adds Calendar.searchEvents(q, {limit})

packages/lib/src/types/
  command-palette.ts               # CommandResult union, PaletteSelection, PaletteContext
  search.ts                        # phase 6 — SearchResponse = { results, total } (shared with PROPOSAL_SEARCH)

packages/lib/src/core/command-palette/
  keys.ts                          # TanStack query keys
  parse-query.ts                   # detect prefix scopes
  smart-parser.ts                  # query → SmartResult[]
  rank.ts                          # final = baseScore + boosts
  commands/
    drive.ts
    mail.ts
    calendar.ts
    docs.ts
    sheets.ts
    slides.ts
    stickies.ts
    chat.ts
    contacts.ts
    nav.ts                         # cross-app jumps
    view.ts                        # sidebar, theme, print
  providers/
    types.ts
    actions.ts                     # FE-only — filters command catalog by query + ctx
    contacts.ts                    # FE-only — composes useContacts() + useMyTeams() (both in lib); reuses the suggestion filter from packages/lib/src/core/contacts/
    smart.ts                       # FE-only — pure smart-parser output
    search.ts                      # the single backend call — TanStack query against /search/:ownerId
    recents.ts                     # phase 8 — wires to home.recents (PROPOSAL_HOME_RECENTS)
  hooks/
    use-command-palette.ts         # open/close
    use-command-results.ts         # the engine — merges providers
    use-palette-selection.ts       # apps publish current selection

packages/ui/src/components/layout/app/command-palette/
  command-palette.tsx
  command-palette-provider.tsx
  command-palette-trigger.tsx
  command-row-action.tsx
  command-row-file.tsx
  command-row-mail.tsx
  command-row-contact.tsx
  command-row-event.tsx
  command-row-chat.tsx
  command-row-smart.tsx
  command-footer.tsx
  use-palette-shortcuts.ts
```

## Key decisions

- **One backend call per keystroke** — FE-only providers (actions, smart, contacts) are
  synchronous `useMemo` over already-cached data; the only network call is `/search/:ownerId`.
  No HTTP fan-out per source.
- **Metadata-LIKE at v1, same URL grows** — `/search/:ownerId` ships with three parallel `LIKE`s
  (`Drive.searchByName` + `MailDB.searchSubjects` via `home.mail` + `Calendar.searchEvents`) —
  the columns are already in SQLite, no new index. When PROPOSAL_SEARCH lands, the route body
  switches to `home.searchIndex.query(...)`. URL, response shape, and FE provider stay stable.
- **No FE-local recents** — don't ship what we'll replace. Recents wait for
  PROPOSAL_HOME_RECENTS. Empty state shows curated suggested commands until then.
- **One Cmd+K, not split** — Notion's split (Cmd+P jump, Cmd+K command) doubles the keyboard
  surface. A single dialog with sectioned results is easier to teach; prefix modes recover the
  precision when wanted.
- **Discriminated union per result kind, not JSON bag** — matches `NotificationCenter`, `SSEvent`,
  `HomeMessage` precedent. TypeScript exhaustiveness across rows/ranking pays for the per-kind
  row component.
- **shadcn `<Command>` primitive** — already shipped, currently unused; perfect fit.
  `shouldFilter={false}` because we blend heterogeneous typed providers and control ranking.
- **Apps publish selection via hook** — not via global state inspection. Cleanest seam, mirrors
  `usePreview` shape, no implicit coupling.
- **Smart parser starts tiny** — email + URL only. Wrong suggestions erode trust; add patterns
  when usage shows demand.
- **Mod+K is hard-coded** — until per-command hotkeys ship in Phase 11. One thing at a time.
