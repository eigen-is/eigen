# Proposal: one detail column across Eigen

Draft for the owner, 25 November 2026, revised after a cold review and the owner's width rulings, not yet ruled on as a whole. It grew out of the calendar's event card ([PROPOSAL_CALENDAR_VIEWS.md](PROPOSAL_CALENDAR_VIEWS.md#cards-and-dialogs)): the owner compared a peek beside the event, a panel at the right and today's dialog, and chose the column for an event's content, with dialogs for edit and create. The owner then asked for one design that comments and a future stickies list view share, and for fewer column widths. It rests on an audit of every side column in Eigen; every code claim below was checked in the code. No route, migration or package is needed.

## 1. The rule in one paragraph

A **detail column** shows one thing the user opened: a message, a contact, a file, an event, a sticky, or a document's conversation (its comments, down to one thread). It opens from a click, the URL names it, and X, Esc or back closes it. It sits at the right, **under the bar that spans the screen**, and carries its own bar. On a phone it replaces the screen with a back arrow, exactly as Mail does. It is not the **sidebar** (navigation, AppShell's), not an **always-on tool** (Slides' rail, Slides' and Vector's properties, which frame the editor and have no close), not a **selection tool** (Docs' and Sheets' properties panels, which follow the cursor) and not a **toggled document tool** (the Docs outline). A detail is opened, closed and linked; a tool is part of the editor.

The one move this makes: comments and activity leave the tool family and become a detail. The owner grouped "comments and calendar info" with Drive, Mail and Contacts, and their behaviour fits: they are opened, closed and linked, never selection-driven.

## 2. Column widths

Today Eigen has nine fixed side-column widths. This section brings them down to three sizes beside `flex`.

### What there is today

| Column | Width today | Where it lives |
|---|---|---|
| App sidebar (every app with a sidebar; Chat's room list is this sidebar) | 256, a 64 rail on a tablet, full width on a phone | `w-64` / `w-16` in `SidebarContainer` |
| Properties panels (Docs, Sheets' image and chart, Slides, Vector) | 256 | `PROPERTIES_PANEL_WIDTH_PX` and its `w-64` in `PropertiesPanel` |
| Comments and activity pane | 256 | `PanelColumn`, from `PROPERTIES_PANEL_WIDTH_PX` |
| Docs outline | 240 | `OUTLINE_WIDTH_PX` in `outline-sidebar.tsx` |
| Slides' slide rail | 208 | `w-52` in `SlidePanel` |
| Mail's list | 400, 320 on a tablet | `listWidth` in `MailRoute` |
| Contacts', Admin users' and teams' list | 350, no tablet step | `ListDetailLayout` |
| Admin waitlist list | 400 | `WaitlistRoute` |
| Drive's detail | 400, also on a tablet | `DriveLayout` |

Not side columns, and out of scope: the stickies board's kanban columns (`w-[280px]` in `column.tsx`, `92vw` on a phone) are the board's content, and the 176px drive list in `DriveBrowser` (`w-44`) lives inside the file picker dialog. Popovers and menus (`w-64`, `w-72`, `w-80`) are not columns.

### Three sizes and `flex`

- **`flex`**: the main, as today.
- **`small`, 256**: navigation and tools. The sidebar, properties, the outline and Slides' rail. Four of the nine already are 256, the outline is 240.
- **`medium`, 320**: a detail beside a work surface. The comments column in Docs, Sheets, Slides, Vector and Stickies, and the calendar's event.
- **`large`, 400, 320 on a tablet**: a list, or a detail beside a list. Mail's list, Contacts', Admin's and the waitlist's lists, Drive's detail.

On a tablet `large` steps down to 320, so there every column that isn't `small` is 320. The sidebar's 64 rail is a mode of the sidebar, not a width a column picks.

Why 400 for `large` (the owner's ruling): Mail's list, the waitlist and Drive's detail already are 400, so three of its five columns don't change, and Mail already steps to 320 on a tablet, where 320 beside the 64 rail leaves a 1024 tablet a 640 main.

Why a `medium` for a detail beside a surface: a list of rows gives up width easily, a page, a slide, a sheet or a week grid does not. Both widths, worked out from the code at 1440 and 1280 wide (a 16:10 screen):

| Beside the detail | Today (256 pane or none) | Detail at 320 | Detail at 400 |
|---|---|---|---|
| Docs, the page moves by (A4, overlay, section 4) | 0 / 0 | 0 / about 1px | about 1px / about 81px |
| Slides, slide width (`fitFrameViewport`, 24px padding, 256 rail; 880 / 720 with properties) | 880 / 720 with a 256 pane | 816 / 656 | 736 / 576 |
| Vector, canvas width (1184 / 1024 with properties) | 1184 / 1024 with a 256 pane | 1120 / 960 | 1040 / 880 |
| Sheets, default 100px columns in view (about, beside the row header) | 11.4 / 9.8 with a 256 pane | 10.7 / 9.1 | 9.9 / 8.3 |
| Calendar week, a day column (grid less the 56px hour gutter, over seven; no detail today) | 161 / 138 | 115 / 93 | 104 / 81 |

At 1440 both work. At 1280, 400 moves Docs' page 81px on every open, shrinks the slide a fifth below what the properties leave it, and cuts a day column to 81px, where a chip shows a cut-off title. 320 keeps Docs' page in place (its clear width is about 1250, so at 1280 it moves about 1px, a few more with a visible scrollbar), costs the slide 64px, and leaves 280px of text inside the 20px gutters: the width of Mail's list on a tablet, room for a thread, its attachment chips and a composer. `small` would leave 216px, too narrow for a thread.

The calendar's event is `medium`, like the editors' and unlike Drive's: its main is a seven-way grid, a surface, where Drive's main is a list of rows that loses nothing at 400. The rule in one line: `large` beside a list, `medium` beside a surface.

### What changes for the user

At 1440 wide unless named.

| Column | Token | Today → after | What the user sees |
|---|---|---|---|
| App sidebar | `small` | 256 → 256 (rail 64) | nothing |
| Properties panels | `small` | 256 → 256 | nothing |
| Docs outline | `small` | 240 → 256 | the outline is 16px wider; it still lies over the page and moves nothing |
| Slides' rail | `small` | 208 → 256 | decided by the owner. Thumbnails grow; the slide is 48px narrower (928 → 880, about 5%) and sits centred between rail and properties instead of 24px left of centre |
| Mail's list | `large` | 400 → 400, tablet 320 → 320 | nothing |
| Contacts, Admin users and teams | `large` | 350 → 400, tablet 350 → 320 | the detail loses 50px; on a tablet it gains 30 |
| Waitlist list | `large` | 400 → 400, tablet 400 → 320 | on a tablet the detail gains 80px |
| Drive's detail | `large` | 400 → 400, tablet 400 → 320 | on a tablet the file list gains 80px |
| Calendar's event detail | `medium` | dialog → 320 | new column; the grid narrows by 320 while it is open (day columns 161 → 115) |
| Comments and activity | `medium` | 256 → 320 | 64px wider while open: the slide 880 → 816; Docs' page doesn't move at 1440 or 1280 |

### One place for the numbers

`packages/ui/src/components/layout/app/column-widths.ts` holds the three numbers and `large`'s tablet step. `Column` takes `width: 'flex' | 'small' | 'medium' | 'large'` and reads `isTablet` from `useLayout()` itself, so no page writes a pixel value or its own tablet branch. `useColumnWidthPx(size)` gives the number to the few hosts that lay out around a column. It replaces Mail's `listWidth`, the literals in `ListDetailLayout`, `WaitlistRoute` and `DriveLayout`, `PROPERTIES_PANEL_WIDTH_PX` (and the `w-64` in `PropertiesPanel` and `SidebarContainer`), `OUTLINE_WIDTH_PX` and Slides' `w-52`. Docs' `PANEL_INTRUSION_PX` becomes the open right column's width from `useColumnWidthPx` minus its 16px, so the overlay maths follows a properties panel at `small` and a detail at `medium`; the outline's `roomStart` reads `small`. The find bar's `right-68` inset (Docs, `CanvasDocumentShell`) becomes the open right column's width plus the bar's gutter, as an inline style.

## 3. The design, visual

### The bar

The rule: **the bar names a list; the body names an item.** A detail bar holds no item title. The item's name is the body's heading, as Mail, Drive and Contacts already do. A bar over a list (the comments list, the activity feed) shows its title at the left, as every list column does.

- Left: on a phone, `Column`'s back arrow. On any screen, an in-column back (`‹ Comments`) when the column has drilled from its list into one item.
- Right: the item's icon actions, then a ⋮ for the rest, then a gap, then X on desktop. On a phone the back arrow closes, so no X. X always means Close, never Reject.
- Height `h-12`, `app-gutter-x`, bottom border fading in on scroll (`toolbarBorder="auto"`), as Drive and Mail.

Where today disagrees, this picks: Mail gets its X (it is the only detail without one; a small fix that can ship any time). The calendar's actions move from the dialog footer into the bar, and the body's heading says "Lunch". Drive's share, watch and ⋮ move from the body into the bar; its filled Open stays under the heading as the one text button. The comments bar keeps "Comments" + filter + New + X at its list level.

### The body

- Inset `app-gutter-x`, `pt-4 pb-6`; one scroller, the body. A thread scrolls above a composer pinned to the bottom with a `border-t`.
- Heading `text-xl font-medium`, as Mail's subject and Drive's name already are. The card's `text-lg` comes in line.
- A meta line under it in `text-sm text-muted-foreground` (date, sender, author).
- Section captions are `eigen-section-label` (small caps), already used by the sidebar sections, Drive's table header, Drive's detail and the comment thread. Contacts' `text-lg` headings with a rule under them are the outlier and change.
- Rows `text-sm`, an icon row (16px muted icon, value, an optional muted second line) for facts like time and calendar, and Drive's label/value rows for metadata.
- Loading: the bar is there at once with its X; the body shows `LoadingState`. Not found: `EmptyState` with the X still there. Nothing selected: no column at all (the waitlist's placeholder column goes).
- One 1px `border-l`, top to bottom, bar included. Background `bg-background` in both themes. A document beside it stays white, as LAYOUT.md rules.

### Where it sits: under the bar that spans the screen

In a list or grid app (Mail, Contacts, Admin, Drive, Calendar) the bar that spans the screen is the app top bar. The detail is a sibling column of the list or grid, with its own action bar, as today. In an editor it is the editor bar, which stays full width; the detail takes the right slot under it, where `PanelColumn` sits in `CanvasDocumentShell` today, and replaces the right tool while it is open. Slides keeps its rail on the left and a column on the right with one top edge, so the balance holds.

List app, Mail, Contacts, Admin, the stickies list view:

```
┌ topbar ───────────────────────────────────────────────────────────────────┐
│ nav 256   │ list 400               │ detail flex                          │
│ Compose   │ [search…            ⋮] │ [ ↩  ↩↩  ↪  🗄  🗑  ⋮           ✕ ] │
│ Inbox     │ row                    │ Bell test new3                       │
│ Drafts    │▌row (open)             │ Bell Tester · 17 Nov, 13:43          │
│ Sent      │ row                    │ Hello from the bell test.            │
└───────────┴────────────────────────┴──────────────────────────────────────┘
```

List and aside, Drive:

```
│ nav 256   │ list flex                              │ detail 400           │
│ New       │ [Drive › folder               ☰  ▦ ]   │ [       👤+  🔔  ⋮  ✕]│
│ Drive     │ NAME                         MODIFIED  │ ┌ preview ─────────┐ │
│ Recent    │▌budget                       2 Nov     │ budget               │
│           │ budget.xlsx                  14 Sep    │ [ Open           ]   │
│           │                                        │ DETAILS              │
```

Grid and detail, Calendar (the grid is its list):

```
│ nav 256   │ grid flex                                │ detail 320         │
│ Create    │ [Today ‹ › 30 Nov – 6 Dec       Week ▾ ] │ [   ✎  🗑  ⤓    ✕ ]│
│ calendars │  MON  TUE  WED  THU  FRI  SAT  SUN       │ Lunch              │
│ mini month│                 ▌Lunch                   │ 🕒 Thu 3 Dec 12:30 │
│           │                                          │ 📅 Reinder Nijhoff │
```

Slides with the comments open: the editor bar spans the screen with its shape tools; rail and detail hang under it with one top edge, the detail in place of the properties:

```
┌ topbar ────────────────────────────────────────────────────────────────────────┐
│ [File Edit Insert     ▭ ◇ ○ ↗ T ▶ 🖼                       🔍 ∿ 🔔 💬 👤+ ] │
│ rail 256 │ slide canvas flex                           │ [Comments    +  ≡  ✕ ] │
│  ▢ 1     │      ┌──────────────────────────┐           │ ┌ test ──────────────┐ │
│  ▢ 2     │      │                          │           │ │ test comment       │ │
│          │      └──────────────────────────┘           │ └ 1 reply ───────────┘ │
```

Closed, Slides is today's layout: the bar over rail, canvas and properties. Docs, thread level: the detail lies over the page's right, as the properties panels do today, and the page stays put:

```
│ [File Edit Insert Format Tools  Normal ▾  B I U …                 🔍 ∿ 🔔 💬 👤+ ] │
│              ┌──────── page, where it was ─────────┐           │[‹ Comments 🔗 ✎ ✓ ✕]│
│              │ adsf                                │           │ fghjfhgj            │
│              │ ▒fghjfhgj▒                          │           │ “quoted anchor”     │
│              │                                     │           │ THREAD  …replies    │
│              └─────────────────────────────────────┘           │ [Reply…          ➤] │
```

Sheets draws its bar inside `Workbook`, so `Workbook` gets one right slot under its menu bar, beside the formula bar and the grid. The detail and `FloatingObjectPanel` both go there:

```
│ [File Edit View Insert Format Data   B I …                    🔍 ∿ 🔔 💬 👤+ ] │
│ fx                                                     │ [Comments     ≡  ✕ ]  │
│    A        B        C        D                        │ ┌ testes ───────────┐ │
│ 1  Item     Link     Format                            │ └───────────────────┘ │
```

Phone, every kind:

```
┌ topbar ─────────────┐        ┌ topbar ─────────────┐
│ [≡  list toolbar  ] │  tap → │ [←       ✎  🗑  ⤓ ] │
│ rows / grid / doc   │ ← back │ Lunch               │
└─────────────────────┘        └─────────────────────┘
```

## 4. Behaviour

**Why under the bar, not to the top.** A detail that ran to the top would take its 320 from the editor bar, and the bars have no room to give. Docs folds its icon row by viewport at 1090, 1270 and 1490 (`showsRow`, `showsMiddle`, `showsAll` in `editor-toolbar.tsx`); a bar 320 narrower is 1120 wide at 1440, which would drop the row's middle and end, and 960 at 1280, which would fold the whole row, B, I and U included, the moment a comment opens. The canvas bar folds its shape tools below 1200 (`useIsCompactToolbar`), so Slides and Vector would lose them on any window up to 1520. Slides' rail would start 48px lower than the column beside it. Under the bar, no bar changes, the share cluster and the comments toggle stay where they are, and no bar needs a container query.

**Sheets today, and its step.** Sheets' comments pane and `FloatingObjectPanel` sit beside the whole `Workbook`, bar included, so they run to the top and the bar folds its format row by container width when one opens (`@[1000px]`, `@[1080px]` in `format-toolbar.tsx`). That is today's exception to the rule. The Sheets step moves both into the `Workbook` slot, so the bar stays full width there too. The slot is a `ReactNode` prop on our fork's `Workbook`; the grid already measures its canvas on resize.

**Docs keeps its overlay.** Properties panels and the detail share one right slot in Docs, and both stay an overlay that never reflows the page (`canvasShift`, `canvasScale`): one geometry in the slot. The page moves only by its overlap: once the scroller is wider than `panelClearWidth` the panel clears the page and nothing moves. For the default A4 page (text column ending at 718px) that is about 1122 at 256, so at 1280 and 1440 the page doesn't move today. At 320 (`medium`) it is about 1250: the page doesn't move at 1440 and moves about 1px at 1280 (the scroller is the window less its 32px padding, so 1408 and 1248; a visible scrollbar adds about 8px). At 400 it would be about 1410, and the page would move about 81px at 1280. Made a sibling, a 320 column would shift the centred page 160px on every open, a click on a highlight included.

**Open and close.** A click opens; X, Esc and back close. Esc closes unless something else took it: a dialog or menu is open (the `useDialogOpen` / `useMenuOpen` guard), a text field, editor or canvas has the focus, or a handler before it called `preventDefault` (Drive's list clearing a multi-selection, the canvas deselecting first). A press on empty space closes nothing, except on the calendar grid, where a press closes and swallows the click so it doesn't create, because there the grid is the list.

**URL.** Each host keeps its own param and its existing link names: `?mailId=`, `?contactId=`, `?userId=`, `?teamId=`, `?entryId=`, `?pid=` (+ `uid`, `mid`), `?eventId=`. Comments use the names that exist: the open thread is `?chat=`, the name copy link writes (`getDriveShareUrl(path, { chat })`) and every editor route already reads (`{ chat, q }`); it already opens a deleted comment. `?card=` stays Stickies' own. The list level is one `?panel=comments` or `?panel=activity`, one slot, as `useDocumentPanels` holds one. `?chat=` alone means the thread with the comments list behind it. `useOpenOnLanding` already resolves a new name again, so a second notification click opens its comment; what is missing today is the clear on close, which the detail does.

**History.** Opening from closed pushes, so a phone's back closes. A switch to another item replaces: Drive's arrow keys (today each one pushes a `?pid`, through `shouldNotify`), another event, list to thread inside the comments column. Close goes back when the entry is our own push and otherwise replaces, so X and back do the same thing and back after X doesn't reopen the item. A deep link or a reload is not our push, so close replaces there. Closing removes only its own params, so Mail keeps its `?q=`. In the comments column `‹ Comments` goes to the list by replace, and a phone's system back closes the column from either level.

**Calendar.** The URL is the open state: `?eventId=` and, for an occurrence of a series, `?occurrence=` with its `occurrenceDate`, the key that stays when that occurrence moves. The detail shows the occurrence the current list holds for that pair. `useEventDetailState`'s `clicked` fallback stays only to bridge a refetch: the moment a save is running and the list lacks the occurrence. After a drag of the open event the URL stays valid (the id and the key don't change) and the detail follows the list. After an edit the detail stays open on the saved event, where today the dialog closes; a save that re-keys the occurrence (a series moved at "all", or a split at "this and following", which creates a new series) replaces the URL with what the save returned, or closes the detail if nothing matches. After a week change the detail stays while the URL names it: the view navigation keeps `eventId` and `occurrence`. A column is a place you read while you look around, such as checking next week against an invitation; Google closes its peek, but a peek covers the grid and a column doesn't. A reload on a week without the event finds nothing and closes the detail by replace, as a not-found link does.

**Phone.** Exactly as Mail: the detail replaces the screen, with the back arrow, and the system back gesture closes it. A main that must survive (an editor, the calendar grid, the board) stays mounted and is hidden with CSS, so an editor keeps its Y.Doc. Lists may keep unmounting, as they do today.

**Tools while a detail is open.** The detail takes the right slot; a right tool yields while it is open, as comments replace properties today. A left tool (the rail, the Docs outline) stays.

## 5. The technical shape

All in `packages/ui`, exported from its barrels; nothing imports a router or carries a permission check.

```tsx
// The frame: the bar and the scrolling body, with the Esc rule. Its host picks medium (beside a surface) or large
// (beside a list).
<DetailColumn
    title?="Comments"            // only over a list
    onBack?={toList}             // in-column back (thread → list); the phone's arrow runs onBack ?? onClose
    actions={…}
    onClose={close}
>
    {body}
</DetailColumn>

// The phone push: on a phone, hides its children with CSS and shows the detail full screen. On a desktop it renders
// its children, and the host puts the detail in its own right slot.
<PhoneDetail detail={detail}>{main}</PhoneDetail>
```

`PhoneDetail` replaces the three hide-the-editor-and-mount-outside copies (docs `editor.tsx`, sheets `editor.tsx`, `CanvasDocumentShell`); Docs' outline pane uses it too. It keeps the main's element tree identical whether the detail is open or not (a class toggles, no wrapper swaps), so an editor never remounts.

`useDetailHistory(value, setValue)` in `packages/ui/src/hooks/` gives `{ open(next), close() }` with the history rule. It takes the host's own typed value and a setter its route writes (`navigate` with `replace`), so state stays the host's and no key-generic helper needs a cast. It remembers in a ref that it pushed the entry it is on; a reload or a deep link starts without it, which is the replace we want. Mail's compose (`mode`, `composeSessionKey`) stays Mail's, outside the hook.

`useFocusInDetail()` joins `useDialogOpen()` in each document keymap, so Vector's Delete, Docs' typing and the sheet's cell keys stand down while the focus sits in the column.

Comments:

- `CommentsColumn` replaces `PanelColumn`: list, activity and thread levels in one `DetailColumn`. `CommentPanel` and `ActivityPanel` drop their `PropertiesPanel` shell (`PanelColumn` cancels it today with `w-full border-l-0`).
- `CardDialog` splits into `CardDetail` (actions and body, no `Dialog`, the deleted state as a body) and a thin dialog around it. `CardDetail` takes an `onEdit` from its host. The column passes one that opens `CardFormDialog`, matching "a dialog when you edit or create"; the board's dialog passes one that edits in place, as today, so the board truly shows no change. The menus' Edit row follows the same host choice.
- The `?chat=` clear moves from `CommentLifecycleDialogs`' `onCardDialogClose` to the route, through the hook.

Order, each merge leaving the app whole:

1. **First merge**: `column-widths.ts` with `Column`'s tokens, `DetailColumn`, `PhoneDetail`, `useDetailHistory`, `useFocusInDetail`; the `CardDetail` split; Calendar (event detail in the column, URL, phone push; `EventDetailDialog` becomes an `EventDetail` body, `useEventDetailState` moves to the route); `CommentsColumn` in `CanvasDocumentShell` (Slides and Vector in one file) with `?panel=` and `?chat=`. The owner checks it at 1280 and 1440 before the rest follows.
2. Docs: `CommentsColumn` in the overlay slot, the intrusion and find-bar inset from the open width, the URL.
3. Sheets: the `Workbook` slot, `FloatingObjectPanel` into it, `CommentsColumn`, the URL.
4. Stickies' activity in `CommentsColumn`, which then works on a phone; `PanelColumn` goes.
5. Drive's actions into the bar, arrow keys replacing; Contacts' and Admin's lists to `large`, the tablet step for the waitlist and Drive; Slides' rail to `small`.
6. Docs in the same cycle as each step: LAYOUT.md (the detail rule, the widths, the placement rule), COMMENTS.md, MOBILE.md, the help-center articles on comments and calendar, CHANGELOG.
7. Later, optional cleanup: Mail's and the waitlist's inline list layouts into `ListDetailLayout`.
8. Later, its own product unit: the stickies list view, under `Board` so the Y.Doc provider stays above both views, a sticky in `CardDetail` in the column.

Mail's missing X is a separate small fix that can ship any time.

### Size

Counted from the files on `develop`; nothing reuses preview code. Rough, about ±30% a row; `CommentsColumn` and the calendar's route-level state are the least certain. Tests come on top, about 200 lines (focus, remount, history, the calendar URL).

| Step | In | Out | Net |
|---|---|---|---|
| 1. Widths, `DetailColumn`, `PhoneDetail`, the two hooks | ~160 | ~20 | +140 |
| 1. `CardDetail` split with `onEdit` | ~30 | ~10 | +20 |
| 1. Calendar in the column (the dialog frame, `useEventDetailState` and three view mounts out) | ~115 | ~130 | −15 |
| 1. `CommentsColumn` and the URL in Slides and Vector (`PanelColumn` still serves the others) | ~190 | ~10 | +180 |
| 2. Docs | ~25 | ~25 | 0 |
| 3. Sheets | ~30 | ~30 | 0 |
| 4. Stickies' activity; `PanelColumn` and the two `PropertiesPanel` shells out | ~15 | ~140 | −125 |
| 5. Drive and the list widths (`DriveDetailToolbar`, five routes' back handlers out) | ~30 | ~70 | −40 |
| Mail's X | ~5 | 0 | +5 |
| **Total** | ~600 | ~435 | **about +165** |
| 7. Later: list layouts into `ListDetailLayout` | ~10 | ~100 | −90 |

The design grows the code a little. What it buys is behaviour: links, back, the phone push and one placement, not fewer lines.

## 6. Comments specifically

**Recommendation: one column that holds the list and drills into a thread, with a back arrow to the list.** The toolbar's comments icon opens the column at the list (`?panel=comments`). A click on a comment in the list, or on its anchor in the document (a highlight in Docs, a cell marker in Sheets, the corner marker on a canvas), opens the thread in the same column (`?chat=`); `‹ Comments` goes back to the list with its scroll kept. Entered from an anchor, the list is still behind the thread, as Mail's list is behind a message opened from a link. Activity is the same column at another list level; an activity row opens its thread with back to the activity. New comment and Edit stay `CardFormDialog`. The hover card on anchors stays. On the stickies board, an activity row opens the sticky in the board's dialog, as today.

Why not a thread beside the list: 256 + 320 at the right is 576px, which in Slides leaves the slide a narrow strip on a laptop. Why not keep the dialog: it is the one item in Eigen that opens in a modal while every other item opens in a column, which is what the owner asked to change.

## 7. Decisions for the owner

1. **Placement.** A detail sits under the bar that spans the screen: the app bar in Mail, Contacts, Drive and Calendar, the editor bar in the editors, which stays full width. Alternative: the detail runs to the top and the editor bar narrows; cost: Docs folds its formatting row (B, I and U at 1280) when a comment opens, Slides and Vector lose their shape tools up to 1520, and Slides' rail and right column lose their shared top edge.
2. **Docs' overlay.** Keep it, for properties and the detail alike, so the page doesn't move at 1440 and moves about 1px at 1280. Alternative: the detail becomes a sibling column; cost: the page jumps 160px on every open, and one slot gets two geometries.
3. **A fourth size for details beside a surface.** Comments in the editors and the calendar's event open at `medium`, 320; `large` (400, the owner's ruling) stays for lists and Drive's detail. At 1280 that leaves the slide 656px wide with comments open, a week's day columns 93px, and Docs' page in place; Drive's share, watch and ⋮ move into its bar either way. Alternative: details at `large` too, three sizes in all; cost: at 1280 the slide 576 (a fifth below what the properties leave it), day columns 81, and Docs' page moving 81px on every open. A detail at `small` (256) is no option: a thread gets 216px of text.
4. **Comments.** One column, the list drilling into a thread, back to the list. Alternative: the list stays and the thread opens beside it; cost: 576px at the right. Keeping the dialog is the other alternative; cost: the ask unmet.
5. **Comments' list level in the URL.** `?panel=comments` or `?panel=activity`, beside the existing `?chat=`, so a phone's back closes the column instead of leaving the document, and a link can open the activity. Alternative: React state, as today; cost: on a phone back leaves the whole document, unlike Mail.
6. **Stickies board.** A sticky on the board keeps opening in its dialog; it opens in the column only in the future list view. Alternative: the board opens a sticky in the column too; cost: the board's sideways scroll loses 320px, and a stickies unit sooner than planned.

## 8. Risks

**Size:** about 8 units (the first merge is four, then Docs, Sheets, Stickies' activity, Drive and the widths) plus the docs pass; about +165 lines, tests on top. The stickies list view is a unit of its own, later.

**What could regress:**

- Focus in collab editors: a thread in a column has no focus trap. Opening a thread focuses its composer. Document keymaps today stand down only while a dialog is open, so Vector's Delete would delete the canvas selection while focus sits on the thread's Resolve button. `useFocusInDetail()` in each keymap and a test per editor (Vector's Delete, Docs' typing, the sheet's cell keys) pin it.
- Remounting: the editor must not remount as the column opens or closes, or the Y.Doc session and undo go. `PhoneDetail` keeps the main's tree fixed; a test opens and closes the column around a live editor and checks the instance survives.
- Docs' page at 320: pixel-gate a paged and a pageless doc at 1280 and 1440, the column open and closed, and with a properties panel open before the column; check the find bar's inset.
- Sheets' slot: the grid must remeasure as the slot opens; the format row no longer folds when a pane opens.
- History: close goes back only after our own push; a deep link or a reload replaces. Pin both in the route tests, and Drive's arrow keys replacing.
- Calendar: the grid narrows by 320 on open; month view's "+N more" counts change with it. A save that re-keys the open occurrence must land on the right one.
- Widths: Contacts' and Admin's list grows to 400 on a desktop and drops to 320 on a tablet; the waitlist and Drive step to 320 on a tablet. Check the rows' second line still fits at 320.

**Bugs this design removes:** Mail's missing X; the waitlist's X meaning Reject and its placeholder column; the calendar's `?eventId=` read once (`didAutoOpen`), never written, never cleared, back not closing, and the first occurrence of a series opening; `?chat=` never cleared in Docs, Sheets, Slides and Vector, so a reload reopens the comment; Drive pushing a history entry per arrow key; Stickies' missing activity on a phone (the ROADMAP "Mobile: next round" row); `PanelColumn` placed three ways; the panel inside a panel; Drive's 400 on a tablet and nine width literals; Mail's close dropping `?q=`; back after a close reopening the item; Drive's `handleBackToList` comment, which names only the narrow screen's back button though it backs the desktop X too.
