# Proposal: Unified Activity Rows

> **TLDR**: The Drive *Recent activity* panel and the topbar notification bell show the same kind of
> information with two different layouts, two phrasing implementations, and inconsistent (or missing)
> links. This proposal unifies them on one row anatomy — a small muted **action** line (`Mark added a card
> to "Eigen Feedback"`, `You moved a card`), one or two normal-size **content** lines (the card title,
> the mail subject + snippet), time right-aligned — rendered by one shared `ActivityRow` component and
> one shared phrasing layer. In the bell, a small app-colored badge on the avatar tells the source app
> at a glance. Every history item and notification type gets a defined action line, content lines, and
> click target (bell → new tab, panel → same tab, deep links down to the card / comment / mail message).
> Data changes are additive only: a `details` JSON column on `notifications` (v2 migration), `cardId`
> / `chatName` fields on existing file-event details, and a `?card=` param on the eigendoc editors.

## Goals

1. **One row anatomy** for both surfaces: line 1 (small, muted) describes the action — who did what,
   where; lines 2–3 (normal size) show the relevant content — card title, destination column, mail
   subject + body snippet. Compact but informative.
2. **One implementation**: a shared presentational row component plus a shared describe layer that
   turns a `FileEvent` or `Notification` into `{ action, primary, secondary }`. The server composes
   notification strings through the same describe function the activity panel renders with.
3. **Complete link coverage**: every item type has a defined click target that lands on the most
   specific thing it can — "added a card" opens the board *and* the card, mail opens the message,
   comments open the thread. Bell links open in a new tab; panel links navigate in place like the
   rest of Drive.

## Non-goals

- **Merging the two feeds.** File events (per-path timeline, mount-owned) and notifications
  (per-user announcements, home-owned) stay separate data models; the `file-event` notification
  pipeline already bridges them. This unifies presentation, phrasing, and links — not storage.
- **A full notifications page.** The bell popover and the details-panel section remain the only
  surfaces (the Space-page idea in NOTIFICATION-CENTER.md stays future work).
- **Per-message mail notification rows.** The constant `mail:new` tag intentionally coalesces all
  incoming mail into one refreshed row; this proposal keeps that and makes the row link to the
  latest message. Per-message rows with counts are a separate decision.
- **Chat message anchors.** Opening the chat room is enough (rooms open at the newest messages);
  no `?message=` param.
- **i18n.** Phrasing stays English, composed strings keep being persisted (see Approaches).

## Current state (research summary)

| | Recent activity panel | Notification bell |
|---|---|---|
| Data | `FileEvent[]` (structured, client-composed) | `title`/`body` strings (server-composed) |
| Layout | 1 truncated line + time line | title + optional body + time (3 different sizes) |
| Phrasing | `ActivityPhrase` switch in `recent-activity.tsx` + `fileEventVerb/Summary` | 13 producer call sites, each inventing its own title |
| Links | **none** — rows are not clickable | same-tab `window.location.href` |
| Content shown | card + column for sticky events, comment preview | whatever the producer packed into the strings |

Notable gaps found while researching:

- `file-event` notifications drop the event details: `notifyWatchers` composes
  `"${actor} added a card to ${board}"` with **no body** — the card title never reaches the bell
  (`apps/api/src/lib/drive/history.ts:226`).
- Mail notifications persist `title: 'New email'`, `body: "From ${fromShort}: ${subject}"` — the
  sender belongs in the action line, the subject is the content, and the body snippet
  (`emails.textShort`) is available at the persist site but unused. Tag is the constant `'mail:new'`
  (NOTIFICATION-CENTER.md says `mail:{messageId}` — doc drift).
- Sticky file events store the card **title** but not its **id**
  (`FileEventDetailsMap['sticky-added'] = { card, toColumn }`), so nothing can deep-link to the card.
- All four eigendoc editors already consume `?chat=<chatName>` via the shared
  `eigenDocEditorValidateSearch` — in stickies it resolves to the card and opens the card dialog.
  A `?card=<cardId>` param is the same mechanism minus the chatName→cardId mapping.
- Mail already supports opening a message via `/box/inbox?mailId=<id>`; the mail notification links
  to the bare inbox.
- Chat/comment titles never use the author's display name even though `postMessage` holds the full
  `User` (`author.name` is unread); share/unshare titles have no actor at all.

## Row anatomy

One shared shape, both surfaces:

```
┌────────────────────────────────────────────────────┐
│ (av)  <action — who did what, where>        <time> │   text-xs muted; time right, shrink-0
│       <primary — the object/content>               │   text-sm (font-medium when unread)
│       <secondary — supporting content>             │   text-sm muted — only when it exists
└────────────────────────────────────────────────────┘
```

- **Action** carries the metadata: actor, verb, container. Small and muted because it's scaffolding.
- **Primary** carries the payload the user actually scans for: card title, mail subject, item name,
  message snippet. Normal size because it's the star.
- **Secondary** exists only where content naturally splits in two: mail subject + snippet, invite
  title + start time, added card + column. One line, truncated, muted.
- **Time** moves into the action line (right-aligned) — saves a full line per row versus today.
- Rows with no content (a plain `edited` on the file you're looking at) collapse to the action line
  alone: `(av) Reinder edited · 2h` — one compact line, not an empty two-line row.
- All lines truncate with ellipsis; no wrapping (`min-w-0` + `truncate`, as today).
- Unread (bell only): row keeps the `bg-primary/5` tint, primary gets `font-medium`. Dismiss ×
  and *Mark all read* stay as they are.
- Avatar slot is always reserved so rows align; a notification without `actorEmail` renders the
  `UserAvatar` fallback.
- Bell rows add an **app badge** on the avatar (see below); panel rows don't.

### Action-line rules

Short and consistent, so rows scan as a column of same-shaped sentences:

- Pattern: `<Actor> <verb> [object/place]`, past tense, as short as it can be while staying
  unambiguous. Implicit context is dropped — "with you" on a share in *your* bell says nothing.
- Two arrival-style exceptions, because "Hanne mailed you" isn't how mail reads:
  `New mail from <sender>` and `New message from <author> in "<chat>"`.
- **The viewer's own actions read "You"** — `You moved a card`, `You updated sharing`. This is a
  render-time rule in the activity panel (`event.actorUserId === viewer id` → "You" instead of
  `UserNameCard`). Notification titles keep their persisted actor names — every producer already
  excludes the actor from delivery, so a notification's actor is never the viewer (the one benign
  exception: mailing yourself).
- Drive item names (docs, boards, chats, files) are double-quoted inside action sentences
  (`commented on "Eigen Feedback"`), bare when they stand alone as the primary line. Column names
  stay bare — short board-internal labels (`added a card to To Do`).

### App badge (bell only)

A small (~14px) circular badge overlaps the avatar's bottom-right corner: white glyph on the source
app's color, ringed with the popover background for separation. It answers "which app"
pre-attentively — the avatar keeps answering "who" (and rescues the rows where the avatar is a
meaningless disc: external mail senders, photo-less accounts — `UserAvatar` has no initials
fallback). The activity panel renders no badge: its context is already a single item or folder, and
every row would repeat the same icon.

| Notification type | Badge |
|---|---|
| `mail` | mail glyph on `--app-mail-color` |
| `mention-chat`, `chat-message` | chat glyph on `--app-chat-color` |
| `mention-comment`, `comment-reply` | `details.pathType` icon + color (`EIGEN_DOC_ICONS` / `colorVar`); fallback chat glyph |
| `calendar-*` (all five) | calendar glyph on `--app-calendar-color` |
| `share`, `unshare`, `access-request`, `file-event` | `details.pathType` icon + color; fallback folder/file glyph on `--app-drive-color` |

Icons and colors come from the existing single sources — `EIGEN_DOC_ICONS`,
`EIGEN_DOC_TYPE_INFO[type].colorVar`, the `--app-*-color` vars — plus lucide
`Mail`/`Calendar`/`Folder`/`File` for the non-eigendoc cases. The mapping lives in `packages/ui`
(icons are a UI concern): `notification-badge.tsx` next to the bell. Producers that know the
affected path record `details.pathType` so the badge can show board vs doc vs sheet; old rows
without it fall back per the table — never blank.

Bell popover:

```
┌──────────────────────────────────────────────┐
│ Notifications                    ✓ Mark all  │
├──────────────────────────────────────────────┤
│ (MK)  Mark added a card to "Eigen Feed…  1d  │
│       Support thread-level mute              │
│       in To Do                               │
├──────────────────────────────────────────────┤
│ (HO)  New mail from Hanne Oberman        1d  │
│       Re: access request                     │
│       I think I'm missing something in t…    │
├──────────────────────────────────────────────┤
│ (DR)  Daan mentioned you in "Eigen Fee…  2d  │
│       @reinder can you look at the sync…     │
└──────────────────────────────────────────────┘
```

Recent activity (file's own panel):

```
RECENT ACTIVITY
(RN)  You moved a card                     2d
      sdgf → Done
(RN)  You added a card to To Do            2d
      Welcome to stickies!
(HO)  Hanne commented                      5d
      "can we move slide 12 before…"
(RN)  You updated sharing                  8d
      Added hanne@example.com
```

## Shared code

### `ActivityRow` — one presentational component

New `packages/ui/src/components/layout/activity-row.tsx` (top-level `layout/`, next to
`user-avatar.tsx` / `user-name-card.tsx`):

```tsx
type ActivityRowProps = {
    actorEmail: string | null;
    badge?: ReactNode;        // bell: app badge overlapping the avatar
    action: ReactNode;        // line 1 content, without the time
    primary?: ReactNode;      // line 2
    secondary?: ReactNode;    // line 3
    createdAt: Date;
    unread?: boolean;         // bell: tint + medium primary
    onOpen?: () => void;      // row becomes button-like when set
    trailing?: ReactNode;     // bell: dismiss button
};
```

`recent-activity.tsx` and `notification-bell.tsx` both become thin: map their items through a
describe function and render `ActivityRow`s. The bell keeps its popover/header/mark-read chrome;
the panel keeps its section label and highlight-scroll behavior.

`action` is a ReactNode so the panel can keep rendering the actor through `UserNameCard`
(live display names, hover card) — notifications render their persisted actor-name string.

### `describeFileEvent` — one phrasing function for file events

Replaces `fileEventVerb` + `fileEventSummary` + the `ActivityPhrase` switch (their only consumers
are `history.ts` and `recent-activity.tsx`; the phrase table stays internal to the new function).
Lives in `packages/lib/src/types/file-history.ts` — same precedent as today: the server composes
notification strings with it, the client renders activity rows with it.

```ts
type ActivityLines = { action: string; primary?: string; secondary?: string };

// ctx 'own':       the panel of the item itself — item name omitted (panel title shows it)
// ctx 'container': folder timelines and notifications — item/board name included
function describeFileEvent(
    event: Pick<FileEvent, 'eventType' | 'details' | 'pathName' | 'pathType'>,
    ctx: 'own' | 'container',
): ActivityLines;
```

The actor is *not* part of the result: the panel prepends `<UserNameCard/>` — or **"You"** when
`actorUserId` is the viewer — and the server prepends `${actor.name} `. Server-side use in
`notifyWatchers`:

```ts
const lines = describeFileEvent({ eventType, details, pathName: itemName, pathType }, 'container');
persist({
    type: 'file-event',
    title: `${actor.name} ${lines.action}`,
    body: lines.primary,
    details: { secondary: lines.secondary, cardId: details?.cardId, chatName: details?.chatName },
    ...
});
```

`fanOut`/`notifyWatchers` gain a `details` pass-through (today they only receive the event type and
item name — this is what currently strands card titles server-side).

### `describeNotification` — the trivial client-side mirror

In `packages/lib/src/core/notification/` next to `resolve-link.ts`: maps a `Notification` row to the
same `ActivityLines` shape — `title` → action, `body` → primary, plus per-type derived secondary
(mail snippet from details, invite start time formatted client-side with the `en-GB` locale). Old
rows without details render whatever they have; nothing breaks.

### The contract producers follow

**`title` = action sentence (who did what, where). `body` = primary content. `details` = structured
extras (secondary line + link parameters).** The SSE toast keeps working unchanged — `toast(title,
{ description: body })` now reads "New mail from Hanne — Re: access request", which is an
improvement by itself.

## Inventory A — notification types

Every type, its new lines, and its click target (bell click = **new tab**). "actor" = display name.

| type | action (title) | primary (body) | secondary | click → |
|---|---|---|---|---|
| `share` | `Hanne shared a board` ¹ | item name | — | item URL (as today) |
| `unshare` | `Hanne removed your access` | item name | — | not clickable (as today) |
| `calendar-share` | `Hanne shared a calendar` | calendar name | — | calendar app |
| `calendar-unshare` | `Hanne removed your access` | calendar name | — | calendar app |
| `calendar-invite` | `Alice invited you` | event title | start time ² | month view `?eventId=` (as today) |
| `calendar-invite-updated` | `Alice updated an invitation` | event title | new start time ² | same |
| `calendar-invite-cancelled` | `Alice cancelled an invitation` | event title | — | same |
| `mail` | `New mail from Hanne Oberman` | subject, or `(no subject)` | body snippet (`textShort`, ~120 chars) | **`box/inbox?mailId=<id>`** (new — id via details) |
| `mention-chat` | `Daan mentioned you in "chat_with_daan"` ³ | message snippet | — | chat room (as today) |
| `mention-comment` | `Daan mentioned you in "Eigen Feedback"` ³ | message snippet | — | doc `?chat=` (as today) |
| `chat-message` | `New message from Daan in "general"` ³ | message snippet | — | chat room (as today) |
| `comment-reply` | `Daan commented on "Eigen Feedback"` ³ | message snippet | — | doc `?chat=` (as today) |
| `access-request` | `Hanne requested access` | item name | request message (moves from body) | share dialog via `?sharePathId=&shareEmail=` (as today) |
| `file-event` | `${actor} ${lines.action}` — e.g. `Mark added a card to "Eigen Feedback"`, `Reinder renamed` | `lines.primary` — card title, `old → new`, item name | `lines.secondary` — e.g. `in To Do` | doc URL **+ `?card=` / `?chat=`** when details carry them; else `fs?pid=&showHistory=1` (as today) |

¹ Noun from `EIGEN_DOC_TYPE_INFO[type].label` lowercased, else `folder` / `file`. Share, unshare and
calendar-share/unshare titles today have no actor name — the ACL/calendar relay messages carry only
`actorEmail`; thread the display name through (it's known at the origin), same as
`access-request-propagation.ts` already does with `requester.name`. Where only an email exists
(external calendar organizers), fall back to its local part.
² `details.startTime` (epoch) formatted client-side (`en-GB`) — avoids baking the server's timezone
into a stored string.
³ `author.name` is already in scope at `ChatRoom.postMessage` (currently unread).

Tags, coalescing, and delivery scopes are untouched — this changes only what's *in* the rows, not
when rows are created. The `file-event` upsert keeps replacing the row with the latest event
(details included), so the coalesced row always describes and links to the newest change.

## Inventory B — file event types (activity panel)

`ctx 'own'` = the selected item's own events; `ctx 'container'` = descendant events in a folder
timeline (and, with the actor name prefixed, the `file-event` notification). Actor always prefixes
the action line.

| eventType | action (own) | action (container) | primary | secondary | click → |
|---|---|---|---|---|---|
| `created` | `created` | `created` | — / item name ⁴ | — | open item ⁵ |
| `uploaded` | `uploaded` | `uploaded` | — / item name ⁴ | size (`details.size`) | open item ⁵ |
| `edited` | `edited` | `edited` | — / item name ⁴ | — | open item ⁵ |
| `renamed` | `renamed` | `renamed` | `Old name → New name` | — | open item ⁵ |
| `moved` | `moved` | `moved` | — / item name ⁴ | — | open item ⁵ |
| `copied` | `copied` | `copied` | — / item name ⁴ | — | open item ⁵ |
| `acl-changed` | `updated sharing` | `updated sharing` | — / item name ⁴ | `Added hanne@…` / `Removed …` (from details) | **share dialog** (`?sharePathId=`) |
| `trashed` | `trashed` | `trashed` | — / item name ⁴ | — | not clickable |
| `restored` | `restored` | `restored` | — / item name ⁴ | — | open item ⁵ |
| `deleted` | `deleted` | `deleted` | — / item name ⁴ | — | not clickable |
| `version-restored` | `restored a version` | `restored a version of "${name}"` | version name | — | open item ⁵ |
| `commented` | `commented` | `commented on "${name}"` | `"preview"` | — | **doc `?chat=<chatName>`** (new detail field) |
| `sticky-added` | `added a card to ${column}` | `added a card to "${board}"` | card title | `in ${column}` (container only) | **board `?card=<cardId>`** (new detail field) |
| `sticky-moved` | `moved a card` | `moved a card in "${board}"` | `${card} → ${column}` | — | **board `?card=<cardId>`** |
| `sticky-removed` | `removed a card` | `removed a card from "${board}"` | card title | — | board (card is gone — no `?card=`) |

⁴ In `own` ctx the panel title already names the item, so drive verbs collapse to an action-only
row; in `container` ctx the item name is the primary line (the item *is* the content).
⁵ "Open item" in the panel = navigate like the rest of Drive (same tab): eigendoc/chat →
`getDriveItemUrl`, folder → `fs` route, plain file → select via `?pid=` (or inline edit URL where
`isInlineEditable`). Events on paths that no longer resolve fall back to non-clickable.

Rows in the panel become clickable for the first time — hover feedback matches the bell
(`hover:bg-muted/50`, `cursor-pointer`), rendered as `role="button"` rows like `NotificationItem`
today.

## Links & navigation rules

- **Bell + toast "View" action**: `window.open(url, '_blank', 'noopener')` — notifications are
  cross-context jumps; a new tab preserves what you were doing. (Today: same-tab
  `window.location.href`.)
- **Activity panel**: same-tab navigation — it's regular in-app Drive browsing, consistent with
  every other open action in Drive (`openDocument` defaults, `fs` links).
- **New deep-link plumbing** (all reusing existing mechanisms):
  1. `?card=<cardId>` added to `eigenDocEditorValidateSearch` (the shared editor-route validator);
     the stickies board passes it as `initialCardId` → `setOpenCardId` — the exact flow `?chat=`
     already uses minus the chatName→cardId mapping, including the clear-param-when-not-found
     behavior. Other editors ignore it for now.
  2. Sticky events record `cardId` (additive `details` field, emitted by the stickies app's
     existing history POSTs).
  3. `commented` events record `chatName` (known at `ChatRoom.postMessage`) so the panel can link
     into the thread the way `comment-reply` notifications already do.
  4. Mail notifications record `mailId` in details; resolver returns
     `getMailAppUrl('box/inbox?mailId=…')`.
  5. `resolveNotificationLink` gains the details parameter for these cases; everything else in it
     stays byte-for-byte.

## Data changes (additive only — eigen.is is live)

1. **`notifications` v2 migration**: `ALTER TABLE notifications ADD COLUMN details TEXT` (JSON,
   nullable). `PersistInput`/`Notification` gain a typed `details` field:

   ```ts
   // packages/lib/src/types/notification.ts
   export type NotificationDetailsMap = {
       mail: { mailId: string; snippet?: string };
       'calendar-invite': { startTime: number };
       'calendar-invite-updated': { startTime: number };
       share: { pathType?: DrivePathType };
       unshare: { pathType?: DrivePathType };
       'mention-comment': { pathType?: DrivePathType };
       'comment-reply': { pathType?: DrivePathType };
       'access-request': { message?: string; pathType?: DrivePathType };
       'file-event': { secondary?: string; cardId?: string; chatName?: string; pathType?: DrivePathType };
   };
   ```

   Types without an entry persist no details. While here, `Notification.type` tightens from
   `string` to a `NotificationType` union (the implicit union already exists in
   `isClickableNotification`); unknown/legacy strings coerce at the read seam like
   `toFileEventType` does.
2. **`FileEventDetailsMap`**: `sticky-added/-moved/-removed` gain optional `cardId`; `commented`
   gains optional `chatName`. JSON column — additive keys, no migration; old rows simply lack them
   and fall back to the container-level link.
3. **No tag changes, no SSE changes, no new tables.** The `home-relay` notification message shape
   picks up `details` for free (it carries `PersistInput`).

**Degradation**: pre-migration rows keep their old strings — they render as action-line-only rows
(or action + old body), still time-stamped, still linked. Notifications churn fast (coalescing +
dismissal), so the mixed period is short and cosmetic only.

## Producer changes (summary)

| Producer | Change |
|---|---|
| `drive/shared-with-me.ts` | split share/unshare into action + name; actor display name threaded through ACL relay; `details.pathType` |
| `calendar/calendar.ts` (5 sites) | action/primary split; invite `details.startTime`; organizer name |
| `mail/mail-domain.ts` | sender → action, subject → body, `details: { mailId, snippet }` |
| `drive/access-request-propagation.ts` | name → primary, message + `pathType` → details |
| `chat/chat.ts` (4 types) | author display name in titles; `commented` file events record `chatName`; comment variants record `details.pathType` |
| `drive/history.ts` | `fanOut`/`notifyWatchers` thread event `details` + `pathType`; compose via `describeFileEvent` |
| `apps/stickies` (history POSTs) | include `cardId` in sticky event details |

## Approaches considered

- **A. Presentation-only** — shared `ActivityRow`, restyle both surfaces, leave all strings and
  links as they are. Cheapest, but the bell still can't show card titles or mail subjects (the data
  isn't in the rows), and no deep links. Doesn't meet the brief.
- **B. Shared row + shared describe + additive details (recommended)** — everything above. One
  component, one phrasing layer, one small migration; producers keep persisting display strings so
  old rows, the SSE toast, and the relay all keep working untouched.
- **C. Fully structured notifications** — persist only facts (`type` + details), compose *all*
  strings client-side. The cleanest end state (single formatter, i18n-ready) but it makes `title`
  legacy-only, requires reworking the toast path (SSE carries composed strings today), and doubles
  the fallback surface — a bigger migration for the same visible result. B is a strict subset of C;
  we can move to C later if i18n becomes real.

## Decisions (review, 2026-07-05)

1. The additive `notifications` v2 migration: **approved**.
2. Mail keeps the **single coalesced row** (`mail:new`), now linking to the latest message.
3. Chat action lines **carry the author**: `New message from Daan in "general"`.
4. Action lines stay short and consistent, and the viewer's own actions read **"You"** — the
   Action-line rules section was added in the same review.
5. Bell rows carry an **app badge** on the avatar (app color + glyph, bottom-right) so the source
   app reads at a glance; the activity panel stays badge-less.

## Files

| File | Change |
|---|---|
| `packages/ui/src/components/layout/activity-row.tsx` | **new** — shared row |
| `packages/ui/src/components/layout/app/notification-badge.tsx` | **new** — notification type → app icon/color badge |
| `packages/ui/src/components/layout/drive/recent-activity.tsx` | rewrite on `ActivityRow` + row links |
| `packages/ui/src/components/layout/app/notification-bell.tsx` | item → `ActivityRow`; new-tab links |
| `packages/lib/src/types/file-history.ts` | `describeFileEvent` (absorbs `fileEventVerb`/`fileEventSummary`); `cardId`/`chatName` detail fields |
| `packages/lib/src/types/notification.ts` | `NotificationType` union, `details` field + `NotificationDetailsMap` |
| `packages/lib/src/core/notification/describe.ts` | **new** — `describeNotification` |
| `packages/lib/src/core/notification/resolve-link.ts` | `mailId`, `?card=`, `?chat=` for commented; rest unchanged |
| `packages/lib/src/core/notification/sse-handlers.ts` | toast "View" opens new tab |
| `apps/api/src/lib/notification-center/{schema,db-config,notification-center}.ts` | v2 migration; `details` on `PersistInput` |
| `apps/api/src/lib/drive/history.ts` | thread details; compose via `describeFileEvent` |
| producer files (table above) | new title/body/details composition |
| `packages/ui/src/components/layout/drive/eigendoc-config.ts` | `card` in `eigenDocEditorValidateSearch` |
| `apps/stickies/src/...` (board route + history emitters) | consume `?card=`; emit `cardId` |
| `apps/api/src/test/file-history.test.ts` + notification tests | `describeFileEvent` cases; details persistence |
| `docs/NOTIFICATION-CENTER.md` | update (incl. pre-existing drift: `mail:new` tag, comment-tag segments, SSE fields) |
