# Activity Rows

> **TLDR**: The reference for what every activity row says and where it links. The bell, Drive's
> *Recent activity* panel and the editors' *Activity* panel all render one `ActivityRow` through one
> shared phrasing layer (`describeFileEvent` / `describeNotification`). The pipeline behind it
> (storage, coalescing, SSE, routes) is [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md).

The three surfaces are the topbar notification bell, the Drive *Recent activity* panel, and the
eigendoc editors' *Activity* side panel (`ActivityPanel`, toggled from `DocumentShareCluster`).

## Anatomy

```
┌────────────────────────────────────────────────────┐
│ (av)  <action — who did what, where>        <time> │   text-xs muted; time right, shrink-0
│       <primary — the object/content>               │   text-sm (font-medium when unread)
│       <secondary — supporting content>             │   text-sm muted — only when it exists
└────────────────────────────────────────────────────┘
```

- Rendered by `ActivityRow` (`packages/ui/src/components/layout/activity-row.tsx`). All lines
  truncate; rows with no content collapse to the action line alone.
- The avatar slot is always reserved so rows align. Bell rows add a small app badge on the
  avatar (`notification-badge.tsx`: app color + glyph from `EIGEN_DOC_ICONS`/`colorVar`,
  `--app-*-color` vars); panel rows don't — their context is already one item.
- Unread (bell only): `bg-primary/5` tint, `font-medium` primary.
- Bell rows navigate in the **same tab** (`window.location.assign` in `notification-bell.tsx`), like
  the panels. Only the toast's **View** action opens a new tab (`window.open(url, '_blank',
  'noopener')` in `packages/lib/src/core/notification/sse-handlers.ts`) — a toast can land while you
  are working, so it must not take you away.

## Action-line rules

- Pattern: `<Actor> <verb> [object/place]`, past tense, as short as it can be while staying
  unambiguous. Two arrival-style exceptions: `New mail from <sender>`,
  `New message from <author> in "<chat>"`.
- The viewer's own actions read **"You"** — a render-time rule in the panel
  (`event.actorUserId === viewer id`); notification titles keep their persisted actor names
  (producers exclude the actor from delivery). Actor names fall back to the email local part;
  actor-less share/unshare rows fall back to `Shared with you` / `Access removed`.
- Drive item names are double-quoted inside action sentences, bare as the primary line.
  Column names stay bare.

## Phrasing layer

- `describeFileEvent(event, ctx, opts?)` (`packages/lib/src/types/file-history.ts`) turns a
  `FileEvent` into `{ action, primary, secondary }`. The server composes `file-event`
  notification strings with it (`history.ts` `notifyWatchers`, ctx `container`); the panel
  renders with it directly. `ctx 'own'` = the selected item's own panel (title already names
  it); `'container'` = folder timelines and notifications.
- `describeNotification(n, opts?)` (`packages/lib/src/core/notification/describe.ts`) maps a
  persisted notification to the same shape; the secondary line derives from `details`
  client-side (invite start time formatted with `en-GB`).
- Chat-derived bodies (mentions, chat messages, comment previews) persist the **raw** message
  text; `formatChatPreview` (`packages/lib/src/core/chat/format-preview.ts`) normalizes it at
  render time in both describe functions and the SSE toast: the emote wire form
  (`$dance:marloes@…`) becomes the chat-style sentence without the actor (`dances with Marloes
  Robijn`, `dances with you` for the viewer), and emails resolve to display names via the
  public-users map (unknown/external addresses stay as-is).

## Notification rows

Actor = display name (email local part as fallback). Chat-derived bodies marked * render
through `formatChatPreview`.

| type | action (title) | primary (body) | secondary | click → |
|---|---|---|---|---|
| `share` | `Hanne shared a board` (noun from `EIGEN_DOC_TYPE_INFO` `noun ?? label`, else folder/file; actor-less: `Shared with you`) | item name | — | item URL |
| `unshare` | `Hanne removed your access` (actor-less: `Access removed`) | item name | — | not clickable |
| `calendar-share` | `Hanne shared a calendar` | calendar name | — | calendar app |
| `calendar-unshare` | `Hanne removed your access` | calendar name | — | calendar app |
| `calendar-invite` | `Alice invited you` | event title | start time (`details.startTime`, epoch ms) | month view `?eventId=` |
| `calendar-invite-updated` | `Alice updated an invitation` | event title | new start time | same |
| `calendar-invite-cancelled` | `Alice cancelled an invitation` | event title | — | same |
| `mail` | `New mail from Hanne Oberman` | subject, or `(no subject)` | snippet (`textShort`, 120 chars) | `box/inbox?mailId=<details.mailId>` |
| `mention-chat` | `Daan mentioned you in "chat"` | message snippet * | — | chat room |
| `mention-comment` | `Daan mentioned you in "Doc"` | message snippet * | — | doc `?chat=` |
| `chat-message` | `New message from Daan in "chat"` | message snippet * | — | chat room |
| `comment-reply` | `Daan commented on "Doc"` | message snippet * | — | doc `?chat=` |
| `access-request` | `Hanne requested access` | item name | request message | share dialog `?sharePathId=&shareEmail=` |
| `file-event` | `${actor} ${lines.action}` via `describeFileEvent` | `lines.primary` * (comment events) | `lines.secondary` | item URL + `?card=`/`?chat=` from details; else `fs?pid=&showHistory=1` |

## File-event rows (activity panel)

`own` = the selected item's own events; `container` = descendant events in a folder timeline
(and, actor-prefixed, the `file-event` notification). Panel rows navigate same-tab per the
table; events on paths that no longer resolve can still point at a stale target (known
limitation — resolving would cost a fetch per row).

| eventType | action (own) | action (container) | primary | secondary | click → |
|---|---|---|---|---|---|
| `created` | `created "<name>"` | `created` | — / item name | — | open item |
| `uploaded` | `uploaded "<name>"` | `uploaded` | — / item name | size | open item |
| `edited` / `moved` / `copied` / `restored` | bare verb | bare verb | — / item name | — | open item |
| `renamed` | `renamed` | `renamed` | `Old → New` | — | open item |
| `acl-changed` | `updated sharing` | `updated sharing` | — / item name | `Added …` / `Removed …` | share dialog (`?sharePathId=`) |
| `trashed` / `deleted` | bare verb | bare verb | — / item name | — | not clickable |
| `version-restored` | `restored a version` | `restored a version of "<name>"` | version name | — | open item |
| `commented` | `commented` | `commented on "<name>"` | `“preview”` * | — | doc `?chat=<chatName>` |
| `sticky-added` | `added a card to <Col>` | `added a card to "<board>"` | card title | `in <Col>` (container) | board `?card=<cardId>` |
| `sticky-moved` | `moved a card` | `moved a card in "<board>"` | `card → col` | — | board `?card=<cardId>` |
| `sticky-removed` | `removed a card` | `removed a card from "<board>"` | card title | — | board (card is gone — no `?card=`) |
| `assigned` | `assigned a comment` | `assigned a comment in "<name>"` | card title, else `to <assignee>` | `to <assignee>` (with card) | doc `?chat=<chatName>` |
| `resolved` | `resolved a comment` | `resolved a comment in "<name>"` | card title | — | doc `?chat=<chatName>` |
| `reopened` | `reopened a comment` | `reopened a comment in "<name>"` | card title | — | doc `?chat=<chatName>` |

`<assignee>` renders as `you` for the viewer, else the resolved display name (email local-part fallback).

## Data

- `notifications.details` (JSON, v2 migration) carries the secondary line + deep-link params —
  see the schema in [NOTIFICATION-CENTER.md](NOTIFICATION-CENTER.md).
- `FileEventDetailsMap`: `sticky-*` carry `cardId` (required on the client POST, optional in
  the read shape — old rows lack it), `commented` carries `chatName`.
- Old rows degrade: no `details` → action + body only; missing `cardId`/`chatName` → the
  container-level link. Never blank, never a crash.
- In-editor mode: the host passes `ActivityPanel` its lifecycle `cards` and an
  `onOpenCard(cardId)`; the panel resolves a row's `cardId`/`chatName` to one id itself. Drive's
  *Recent activity* mounts `ActivityEventList` directly, with no `onOpenCard`, so its rows keep
  their deep links.
