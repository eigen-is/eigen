# Code Quality Follow-ups (2026-04-23)

Follow-ups identified during the drive-picker / save-to-drive review session.
Ordered by priority. Do them in this order unless the user overrides.

## Priority order

1. **Mail-draft hook trio refactor** — biggest bug surface, smallest audit, user-facing impact
2. **Drive + SharedDrive wrapper pattern** — eliminate a recurring architectural pitfall
3. **routes/drive.ts eigendoc-create consolidation** — lines-of-code cleanup
4. **ChatMessageInput suggest state machines** — complexity reduction

Each item ends with an acceptance bar. After each section, check in with the user before
moving to the next.

---

## 1. Mail-draft hook trio refactor

### Files
- `packages/lib/src/core/mail/hooks/use-draft.ts`
- `apps/mail/src/components/mail/hooks/use-draft-state.ts`
- `apps/mail/src/components/mail/hooks/use-draft-auto-save.ts`
- `apps/mail/src/components/mail/email-draft.tsx` — callsite, especially
  `sendWithFreshDraft` around L206–216

### Current smells
- Auto-save with fingerprint dirty-detection + debounced scheduling + explicit flush
  + disable-on-send + server-id-assignment
- Four interlocking concerns coordinated via refs and callbacks across three files
- `sendWithFreshDraft` reads like it was shaped by race-condition bugs:
  `saveNow()` → `disableAutoSave()` → `toDraft()` → splice server-id into draft
- I patched symptoms here last session (scheduleSave on ref removal, parallelize
  handleDriveAttach); the underlying state machine is untouched

### Approach
Consolidate into a single reducer-style state machine with explicit states:
`idle | dirty | saving | sent`. Transitions:
- `user-edits` → `dirty`
- `debounce-fires` → `saving`
- `save-succeeds` → `idle` (or `dirty` if edits arrived during save)
- `user-sends` → flush-then-send → `sent`

Preserve the fingerprint-based dirty detection but move it into the reducer.
Kill the ref-mutation patterns — pure state + pure transitions.

### Audit steps (do BEFORE touching code)
1. Read all three files + `email-draft.tsx` end-to-end
2. Diagram the current state transitions and refs
3. List latent races: what happens if user types during save? Sends before first
   save completes? Auto-save fires after send is already in flight?
4. Sketch the new state machine
5. Get user approval before implementing

### Acceptance
- Three files merge into at most one hook file (or state machine + thin public hook)
- Existing mail tests still pass (`bun test apps/api/src/test/mail*.test.ts`)
- `sendWithFreshDraft` becomes a straight-line call — no splice-server-id dance
- New unit tests cover each transition, including sending-while-saving and
  editing-while-saving

---

## 2. Drive + SharedDrive wrapper pattern

### Files
- `apps/api/src/lib/drive/drive.ts`
- `apps/api/src/lib/drive/sharedDrive.ts`
- `apps/api/src/routes/drive.ts` and any route that calls `getSharedDrive`

### Problem
Every time a new method is added to `Drive`, a matching ACL-wrapped method must be
added to `SharedDrive`. If forgotten, routes can accidentally bypass ACL. The review
already flagged this as a recurring pitfall:
*"`SharedDrive` must wrap every public `Drive` method"*.

### Approach (branded types, compile-time enforcement)
1. Add `type UnguardedDrive = Drive & { readonly __unguarded: unique symbol };`
2. Make `getDrive()` / `getHome().drive` return `UnguardedDrive`
3. `getSharedDrive()` is the only public factory consumers see — returns `SharedDrive`
4. `SharedDrive` constructor takes `UnguardedDrive` internally; the brand is attached
   only where we know the caller is trusted (inside `SharedDrive`)
5. TypeScript refuses any route that tries to hold a raw `Drive`/`UnguardedDrive`

### Optional defense-in-depth
A Proxy-based runtime check: every `SharedDrive` method runs through a wrapper that
requires an ACL predicate be declared in a central registry.

### Acceptance
- Every route typechecks after branding
- Adding a new method to `Drive` without a matching `SharedDrive` method fails
  the build (or throws at runtime if the proxy path is added)
- No existing test regressions

---

## 3. routes/drive.ts eigendoc-create consolidation

### File
`apps/api/src/routes/drive.ts` (510 lines)

### Current
Five near-identical eigendoc-creation endpoints:
- `POST /folder/:pathId/doc`
- `POST /folder/:pathId/stickies`
- `POST /folder/:pathId/slides`
- `POST /folder/:pathId/sheets`
- `POST /folder/:pathId/chat`

### Goal
Consolidate into `POST /folder/:pathId/create/:type` where `:type` is an
`EigenDocType`. Mirrors the unified `DriveCreateEigenDoc` frontend and
`useCreateDriveItem(type)` hook that already exist.

### Acceptance
- Frontend `useCreateDriveItem` in `use-drive.ts` updated to call the new endpoint
- Eden Treaty types flow correctly end-to-end
- Existing create tests still pass
- ~50 line reduction in routes/drive.ts

---

## 4. ChatMessageInput suggest state machines

### File
`packages/ui/src/components/layout/chat/chat-message-input.tsx` (~400 lines)

### Current
Three parallel state machines — @-mentions, slash commands, slash targets — each
with their own `selectedIdx` state, `countRef`, and keyboard arrow-up/down/enter/
escape handling. ~100 lines of duplicated control flow.

### Goal
Extract a `useSuggestions({ items, onSelect, visible })` hook that handles:
- Selected index with arrow keys
- Enter / Tab to commit
- Escape to close
- Resetting when items change

All three suggest popovers use the same hook.

### Acceptance
- ~100 line reduction in chat-message-input.tsx
- No behavioral regression: manual test typing `/`, `@`, `/emote ` — all three
  suggests work identically
- Easy to add a fourth kind of suggestion later

---

## 5. Reply/Forward should not persist a draft on click

### File
`apps/mail/src/components/mail/hooks/use-mail-actions.ts`

### Current
`handleReplyEmail` / `handleReplyAllEmail` / `handleForwardEmail` all call
`handleNewDraftEmail`, which immediately POSTs to update-draft via
`updateDraft.mutateAsync({ draft: mail })`. Result: clicking Reply leaves an
empty quoted-reply in Drafts even if the user never types or sends.

Most mail clients (Gmail, Apple Mail, Outlook) only persist a draft once the
user has typed at least one character beyond the quoted body or the autosave
debounce fires. Eigen persists eagerly, which clutters Drafts.

### Goal
Defer the first save until the user actually edits the compose. The new
`useDraft` hook in `email-draft.tsx` already has a fingerprint-based dirty
detector — letting *it* decide when to first POST gives consistent behavior
between fresh-compose and reply/forward.

### Sketch
- `handleReplyEmail` builds the draft locally and pushes it into the route as
  initial state (no API call). Use `mode='compose'` with the prefilled
  subject/body/to.
- `useDraft.initFields` accepts the prefilled values; `lastSavedFingerprint`
  is seeded from them. No drift → no save until user types.
- First save assigns the id (existing flow), then `onDraftIdAssigned` puts
  it in the URL so reload still works.

### Acceptance
- Clicking Reply on an email and immediately closing leaves NO draft in Drafts
- Typing into the reply causes a save after the debounce, as today
- Existing mail tests pass

---

## How to resume

1. Read this file
2. Start with section 1 (mail-draft trio). Do the audit step first — do not touch
   code until the state-machine sketch is approved by the user
3. Each section gets its own commit(s). Run `bun run check` before committing
4. After each section, check in with the user before moving to the next
