# Code Quality Follow-ups (2026-04-23)

Follow-ups identified during the drive-picker / save-to-drive review session.
All six sections shipped on 2026-04-23.

## Status

| # | Title | Status |
|---|-------|--------|
| 1 | Mail-draft hook trio refactor | ✅ shipped (`180d6014`, `b45af345`, `ed2de47e`) |
| 2 | Drive + SharedDrive wrapper pattern | ✅ shipped (`6483ed81`, `ed2de47e`) |
| 3 | routes/drive.ts eigendoc-create consolidation | ✅ shipped (`74924e55`, `ed2de47e`) |
| 4 | ChatMessageInput suggest state machines | ✅ shipped (`eacab998`) |
| 5 | Reply/Forward should not persist a draft on click | ✅ shipped (`1a359373`) |
| 6 | Mail draft attachment merge drops in-flight tempId attachments | ✅ shipped (`d883dd49`) |

## Notes on shipped sections

- **§1** merged into one `useDraft` hook (`apps/mail/src/components/mail/hooks/use-draft.ts`).
  Acceptance bar around "new unit tests for each transition" was deferred —
  no React Testing Library infra exists and adding it just for one hook was
  out of scope. See §6 for one race that survived the refactor.
- **§2** deviated from the original plan's branded-type approach. Branding
  alone wouldn't have closed the inheritance bypass (`SharedDrive extends
  Drive` made every `Drive` method appear on `SharedDrive` for free). The
  shipped solution drops `extends`, returns `Drive | SharedDrive` from
  `getSharedDrive`, and lets the union's intersection enforce wrappers at
  compile time. Owner perf is preserved (own-drive returns raw Drive).
- **§3** straightforward consolidation — the literal-union validator in the
  route is intentionally explicit so Elysia preserves the tuple in
  `params.type` and the handler's switch stays exhaustive at compile time.

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
Defer the first save until the user actually edits the compose. The
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

## 6. Mail draft attachment merge drops in-flight tempId attachments

### File
`apps/mail/src/components/mail/hooks/use-draft.ts` — `mergeServerAttachments`

### Problem
When a save is in flight and the user attaches a *new* file during the
network round-trip, the server's response only describes the attachments it
saw. `mergeServerAttachments` replaces the local list with that response —
silently dropping the new `tempId` attachment that was added mid-flight. The
next auto-save then doesn't include it.

This race existed before §1 and §1's refactor preserved the behavior. Worth
fixing as its own change because the fix needs careful thought about
ordering (what if the user *removes* an attachment during the save? it
should stay removed).

### Sketch
- In `mergeServerAttachments`, keep any local entry that has a `tempId`
  AND isn't represented in the server's response (matched by filename+size).
- Test scenarios:
  1. Attach A, save fires, attach B during save → both A and B end up persisted
  2. Attach A and B together → both persisted
  3. Attach A, remove A during save → A removed
  4. Server returns extra attachments not in local → server is authoritative

### Acceptance
- Manually verify scenario 1 above
- Existing mail integration tests still pass

---

## How to resume

1. Read this file
2. Pick the next pending section (4, 5, or 6 — independent of each other)
3. Each section gets its own commit(s). Run `bun run check` before committing
4. After each section, check in with the user before moving to the next
