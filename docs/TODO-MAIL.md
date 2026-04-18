# Mail — Follow-ups and Signature Plan

Follow-up work tracked after the mail composer modernization (`feat/mail-composer` merged
2026-04-17). Two parts: (1) code-quality items deferred from the code review, (2) the
signatures feature originally scoped with the composer refactor.

---

## Part 1 — Code-quality follow-ups

Items surfaced by code review but deferred from the composer merge.

### Completed (2026-04-18)

**Quota enforcement on draft attachment uploads** — ~~hardcoded 25 MB limit~~ → now uses
`getMailUploadMaxSize(userId)` from `enforcement.ts`, which consults `mailAndContactsMax`
quota (server default + team overrides) and `maxUploadSizeMB`. Error message shows actual limit.

**Plain-text body extraction** — ~~regex stripping~~ → `LightEditor` now emits plain text via
`onChangeText` callback using Tiptap's `editor.getText()`. `useDraftState` stores `bodyText`
separately, used by `toDraft()` and `isSaveable`. Proper entity decoding and newlines.

**Autosave heaviness under a large attachment** — draft-meta sidecar (`draft-meta/<id>.json`)
stores mutable fields (subject, body, recipients, attachment metadata). Body-only saves write
only the ~1 KB JSON file + update the DB record. Full EML rebuild only on attachment changes
or send. `messageGet` overlays sidecar values on the stale EML.

**`setId`'s synchronous `stateRef` mutation** — removed. `sendWithFreshDraft` now reads the
id from `saveNow()`'s return value instead of relying on the stateRef side-channel.

**Test coverage gaps** — `mail-attachments.test.ts` expanded from 7 to 13 tests:
- Empty `tempAttachmentIds: []` vs `undefined` equivalence
- Concurrent uploads on the same draft, single save with both tempIds
- Default `contentType` for files with no MIME → `application/octet-stream`
- `cleanupStaleDraftTemps` correctness under mixed-age files
- Body-only re-save uses fast path and preserves attachments
- Send after fast-path saves includes attachments

### Remaining

**Manual regression testing of the composer flow** — backend integration tests cover the
round-trips but the race fixes (saveNow serialization, mode+mailId coexistence, remount key)
would benefit from an end-to-end Playwright test covering:
attach → save → edit → re-save → remove → send.

### Low priority

**`formatEmailQuote` signed-string HTML** — currently builds `<br><br><p>header</p><blockquote>
content</blockquote>` via string concatenation. Works (header fields are escaped, content is
either already-sanitized html or escaped text) but a safer pattern is to build a DOM fragment
and extract its innerHTML. Only matters if we start embedding user-controlled strings beyond
the current two fields.

---

## Part 2 — Signatures

Planned but deferred from the composer refactor. Design was approved during brainstorming
(spec at `docs/superpowers/specs/2026-04-17-mail-composer-design.md` section D); only the
settings-page placement changed after implementation started — see decision below.

### Storage

Extend `UserSettings` in `packages/lib/src/types/settings.ts`:

```typescript
export type MailSignature = {
    id: string;
    name: string;
    html: string;
};

export type UserSettings = {
    theme?: 'light' | 'dark' | 'system';
    mounts?: Record<string, MountSettings>;
    signatures?: MailSignature[];
    defaultSignatureId?: string | null;
};
```

Array-of-signatures shape from day one (future multi-signature picker). Initial UI exposes
only a single signature; no picker in the composer.

### Settings UI placement

A new `/email` sidebar item in the space app (decision locked in 2026-04-17 during the
composer session — option 2 over "add card to existing services page"). Rationale: signatures
are personalization, not connection/access configuration. Room for future email-specific
preferences (default reply behavior, auto-BCC, etc.) without crowding the services page.

**Files to create:**
- `apps/space/src/routes/_auth.email.tsx` — new route with the signature editor
- Add an entry to `apps/space/src/components/space/space-sidebar.tsx` (between Security and
  Services, using the `Mail` icon from lucide-react that's already imported there)

**Editor component:** reuse the shared `LightEditor` with `toolbar="fixed"` and a compact
layout. Live HTML preview below. Save button that fires `useUpdateSpaceSettings().mutate`.

### API changes

`apps/api/src/routes/space.ts` — extend the PUT body schema:

```typescript
body: t.Object({
    theme: t.Optional(t.Union([t.Literal('light'), t.Literal('dark'), t.Literal('system')])),
    signatures: t.Optional(t.Array(t.Object({
        id: t.String(),
        name: t.String(),
        html: t.String(),
    }))),
    defaultSignatureId: t.Optional(t.Union([t.String(), t.Null()])),
}),
```

`JsonStore<UserSettings>` already handles partial deep-merge, so no server logic changes
beyond the schema.

### Compose behavior

**New compose:** default signature appended below a `---` separator (HTML `<p>---</p>`) at
the end of the body. Editable inline — the signature isn't a locked block, just content.

**Reply/forward:** signature inserted between the new-content area and the quoted original,
like most mail clients.

**Edit existing draft:** signature already baked into the saved body, no re-insertion. This
is the natural consequence of signatures being injected into `initState` only when `email`
is null.

Injection point is `useDraftState.initState`:

```typescript
export function useDraftState(email: EmailDraft | null, prefillTo?: string, signature?: string) {
    const [state, setState] = useState<DraftState>(() => {
        const base = initState(email, prefillTo);
        if (!email?.id && signature) {
            const sep = '<p>---</p>';
            base.body = base.body
                ? `<p><br></p>${sep}${signature}${base.body}`
                : `<p><br></p>${sep}${signature}`;
        }
        return base;
    });
    // ...
}
```

Signature is fetched via `useSpaceSettings()` in `EmailDraft`, passed to `useDraftState`. The
hook only uses the signature prop once (lazy `useState` initializer) so prop changes don't
retro-inject into existing drafts.

### Implementation tasks

1. **Add `MailSignature` + `signatures` + `defaultSignatureId` to `UserSettings` type**
   (`packages/lib/src/types/settings.ts`).
2. **Update space PUT body schema** in `apps/api/src/routes/space.ts`.
3. **Create `apps/space/src/routes/_auth.email.tsx`** — new route with `LightEditor` +
   preview + save button. Uses `useSpaceSettings` / `useUpdateSpaceSettings`.
4. **Add sidebar entry** in `apps/space/src/components/space/space-sidebar.tsx` between
   Security and Services, linking to `/email` with the `Mail` icon.
5. **Extend `useDraftState`** to accept an optional `signature` parameter and inject it on
   `initState` for new compose only.
6. **Thread signature through `EmailDraft`** — read from `useSpaceSettings()`, pass to
   `useDraftState`.
7. **Manual test** — open space settings, enter a signature, compose a new mail (should
   appear), reply to an existing mail (should appear between new area and quote), edit an
   existing draft (no double-injection).

Estimated: one sub-agent pass, ~100–150 lines of new code across 4 files plus minor edits.

### Out of scope for the initial signature feature

- Multi-signature picker in the composer
- Per-identity signatures (when multiple from addresses land)
- Signature templates / variables
- HTML signature validation/sanitization beyond what `LightEditor` already produces

---

## Notes

- Branch that landed the composer refactor: `feat/mail-composer` (18 commits, merged 2026-04-17)
- Design spec: `docs/superpowers/specs/2026-04-17-mail-composer-design.md`
- Implementation plan: `docs/superpowers/plans/2026-04-17-mail-composer.md` (Tasks 9 + 10
  there describe signatures — same content as Part 2 above but with more inline code)
