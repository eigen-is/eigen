# Mail — Signature Plan

## Status

Code-quality follow-ups from the composer refactor (`feat/mail-composer`, merged 2026-04-17)
are all complete. Remaining deferred items:
- E2E Playwright test for compose flow (attach → save → edit → re-save → remove → send)
- `formatEmailQuote` could use DOM fragments instead of string concatenation (low priority,
  current approach is safe)

---

## Signatures (not started)

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
