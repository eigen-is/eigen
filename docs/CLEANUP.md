# Cleanup & Optimization — Remaining Items

| # | Item | Priority | Category | Effort | Location / Notes |
|---|------|----------|----------|--------|------------------|
| 1 | List virtualization | P2 | Frontend | 2-3 days | DriveTable, EmailList, ChatMessageList. Use `@tanstack/react-virtual` |
| 2 | Font lazy-loading | P2 | Bundle | 2-4 hr | `fonts.css` loads 4 families; only Inter needed by default |
| 3 | Thumbnail retry | P2 | Backend | 1-2 hr | Fire-and-forget with no retry. Store `thumbnailStatus`, retry on access |
| 4 | Contacts.size() N+1 | P2 | Backend | 30 min | Calls `storage.size()` per avatar file. Store sizes in DB |
| 5 | Auth error handling in Space | P2 | Arch | 2-3 hr | `security.password.tsx`, `security.2fa.tsx` use direct `authClient` + `toast.error`. Wrap in hooks |
| 6 | Direct `useQueryClient` in app | P3 | Arch | 15 min | `native-file-editor.tsx`. Add `invalidateEditorContent()` to `packages/lib` |
| 7 | Large monolithic components | P3 | Quality | per-file | `editor-toolbar.tsx` (775), `slides/editor.tsx` (691), `contact-edit.tsx` (668), `slide-properties-panel.tsx` (647), `team-detail.tsx` (429), `chat-message-input.tsx` (367) |
| 8 | `interface` → `type` remaining | P3 | Quality | 30 min | ~20 instances left (many in generated `routeTree.gen.ts`) |
| 9 | Shadow DOM hardcoded colors | P3 | Quality | 30 min | `shadow-content.tsx` uses `#333`/`#2563eb`. Inject via `getComputedStyle` |
| 10 | Contacts `relations()` possibly dead | P3 | Quality | 15 min | Drizzle relations exported but `.query.` never used |
| 11 | `as ViewMode`/`as RecurringAction` casts | P3 | Quality | 15 min | Select/RadioGroup `onValueChange` returns `string` |
| 12 | Console stripping in production | P3 | Bundle | 30 min | ~17 `console.*` calls left in fortune-sheet |
| 13 | Image lazy loading | P3 | Bundle | 2-3 hr | Zero uses of `loading="lazy"` |
| 14 | Email date formatting in render loop | P3 | Frontend | 30 min | `email-list.tsx` creates Date/Intl per render. Memoize |
| 15 | Mail parser `as unknown as` casts | Info | Quality | large | 15+ casts in ported mailparser. Major rewrite, low ROI |
| 16 | Collab `as Uint8Array` casts | Info | Quality | — | Drizzle blob → Buffer, Yjs needs Uint8Array. Safe, Drizzle limitation |
