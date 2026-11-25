# Proposal: one detail column across Eigen

Ruled on by the owner, 25 November 2026, after a cold review (section 7 holds the decisions); not built yet. It grew out of the calendar's event card ([PROPOSAL_CALENDAR_VIEWS.md](PROPOSAL_CALENDAR_VIEWS.md#cards-and-dialogs)): the owner compared a peek beside the event, a panel at the right and today's dialog, and chose the column for an event's content, with dialogs for edit and create. The owner then asked for one design that comments and a future stickies list view share, and for fewer column widths. It rests on an audit of every side column in Eigen. The code claims below were checked against `develop` and the prototype on 25 November 2026, after a cold read caught some that were wrong; the build checks each one again as it reaches it. No route, migration or package is needed.

A throwaway prototype validated the design on 25 November 2026: the widths, the Docs overlay, and the column in Calendar, Slides, Vector and Docs. Its numbers match the tables below (Docs' page left edge at 1440: 323 closed, 323 with the list, 322 with a thread; at 1280: 243, 242, 162). It changed the calendar's not-found case, the history rule's "our own push", the grid's press rule, the Esc order, the `CardDetail` shape and the single source for the open thread, and it found the gaps the sections below now name. The build redoes it on a new branch from this text.

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
- **`small`, 256**: navigation and tools. The sidebar, properties, the outline and Slides' rail. Three of the nine already are 256 (the sidebar, the properties panels and the comments pane); the outline is 240 and Slides' rail 208.
- **`medium`, 320**: a detail beside a work surface. The comments and activity lists in Docs, Sheets, Slides, Vector and Stickies, and the calendar's event.
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

The calendar's event is `medium`, like the editors' and unlike Drive's: its main is a seven-way grid, a surface, where Drive's main is a list of rows that loses nothing at 400. The rule in one line: `large` beside a list, `medium` beside a surface. One exception, the owner's: an open comment thread is `large`. The comments column is `medium` at its list level and grows to `large` when it drills into a thread, since reading and writing a conversation needs the room, and steps back to `medium` on `‹ Comments`. On a tablet both are 320, so nothing grows there.

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
| Comments and activity, list level | `medium` | 256 → 320 | 64px wider while open: the slide 880 → 816; Docs' page doesn't move at 1440 and moves about 1px at 1280 |
| A comment thread | `large` | dialog → 400 | the column grows 80px as a thread opens: the slide 816 → 736 at 1440 (656 → 576 at 1280); Docs' page stays at 1440 and moves about 81px at 1280 |

### One place for the numbers

`packages/ui/src/components/layout/app/column-widths.ts` holds the three numbers and `large`'s tablet step. `Column` takes a strict `width: 'flex' | 'small' | 'medium' | 'large'` and reads `isTablet` from `useLayout()` itself, so no page writes a pixel value or its own tablet branch. A strict type leaves no caller behind, so the step that makes it strict converts every `Column` that passes a pixel value, each in one line: Mail's `listWidth` (`large`), `ListDetailLayout`'s `'350px'` (`large`), the waitlist's `'400px'` (`large`), `DriveLayout`'s `'400px'` (`large`), `PanelColumn`'s `PROPERTIES_PANEL_WIDTH_PX` (`small` until `CommentsColumn` replaces it), the Docs outline's `OUTLINE_WIDTH_PX` (`small`) and Docs' editor's `'w-full'`, which was never a valid width (`flex`). `columnWidthPx(size, isTablet)` and `useColumnWidthPx(size)` give the number to the few hosts that lay out around a column. It replaces Mail's `listWidth`, the literals in `ListDetailLayout`, `WaitlistRoute` and `DriveLayout`, `PROPERTIES_PANEL_WIDTH_PX`, `OUTLINE_WIDTH_PX` and Slides' `w-52`. Three widths are classes on plain elements, not a `Column`: the `w-64` in `PropertiesPanel`, the `w-64` in `SidebarContainer` (its `w-16` rail stays, a mode of the sidebar) and Slides' `w-52` rail. Each takes its width from `small` as an inline `style`, so one number moves them all; the prototype left the first two as `w-64` and wrote the third as `w-64`, a second copy of 256. Docs' `PANEL_INTRUSION_PX` becomes the open right column's live width from `useColumnWidthPx` minus its 16px gutter, so the overlay maths follows a properties panel at `small`, the list at `medium` and a thread at `large`; the outline's `roomStart` reads `small`. The find bar's `right-68` inset (Docs, `CanvasDocumentShell`) becomes that width plus the bar's gutter, through a new `barStyle` on `DocSearchProvider`, since a class can't follow a live width.

## 3. The design, visual

### The bar

The rule: **the bar names a list; the body names an item.** A detail bar holds no item title. The item's name is the body's heading, as Mail, Drive and Contacts already do. A bar over a list (the comments list, the activity feed) shows its title at the left, as every list column does.

- Left, on a phone: `Column`'s back arrow, which is the in-column back. From a thread it goes to the list; from the list, or from a column with no list level, it closes the column, back to the document or the list beside it.
- Left, off the phone: an in-column back (`‹ Comments`) when the column has drilled from its list into one item. It shows only off the phone, where the arrow already does the job.
- Right: the item's icon actions, then a ⋮ for the rest, then a gap, then X off the phone. On a phone the back arrow closes, so no X. X always means Close, never Reject.
- Height `h-12`, `app-gutter-x`, bottom border fading in on scroll (`toolbarBorder="auto"`), as Drive and Mail.

Where today disagrees, this picks: Mail gets its X (it is the only detail without one; a small fix that can ship any time). The calendar's actions move from the dialog footer into the bar, and the body's heading says "Lunch". Its RSVP stays in the body, under an `eigen-section-label`: Decline's icon is an X, and in a bar an X only ever means Close. Drive's share, watch and ⋮ move from the body into the bar; its filled Open stays under the heading as the one text button. The comments bar keeps today's order at its list level: "Comments", then `+` (New comment), then the filter, then X. New is there only on a canvas host (Slides, Vector), which adds a comment anchored to no element (`onAddComment` on `PanelColumn` today). Docs and Sheets anchor each comment to their content, so their bar has no New: Docs makes a comment from the Insert menu or the selection's context menu, Sheets from the Insert menu or a cell's context menu.

### The body

- Inset `app-gutter-x`, `pt-4 pb-6`; one scroller, the body. A thread scrolls above a composer pinned to the bottom with a `border-t`; that composer is the thread's own, so the column has no footer slot (section 5).
- Heading `text-xl font-medium`, as Mail's subject and Drive's name already are. The card's `text-lg` comes in line.
- A meta line under it in `text-sm text-muted-foreground` (date, sender, author).
- Section captions are `eigen-section-label` (small caps), already used by the sidebar sections, Drive's table header, Drive's detail and the comment thread. Contacts' `text-lg` headings with a rule under them are the outlier and change.
- Rows `text-sm`, an icon row (16px muted icon, value, an optional muted second line) for facts like time and calendar, and Drive's label/value rows for metadata.
- Loading: the bar is there at once with its X; the body shows `LoadingState`. Not found: `EmptyState` with the X still there; the calendar's reads "This event isn't in this view". Nothing selected: no column at all (the waitlist's placeholder column goes).
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
│           │                                          │ 📅 Personal        │
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

**Docs keeps its overlay.** Properties panels and the detail share one right slot in Docs, and both stay an overlay that never reflows the page (`canvasShift`, `canvasScale`): one geometry in the slot. The page moves only by its overlap: once the scroller is wider than `panelClearWidth` the panel clears the page and nothing moves. For the default A4 page (text column ending at 718px) that is about 1122 at 256, so at 1280 and 1440 the page doesn't move today. At 320 (`medium`) it is about 1250: the page doesn't move at 1440 and moves about 1px at 1280 (the scroller is the window less its 32px padding, so 1408 and 1248; a visible scrollbar adds about 8px). At 400, the width of an open thread, it is about 1410: the page stays at 1440 and moves about 81px at 1280 while a thread is open. Made a sibling, a 320 column would shift the centred page 160px on every open, a click on a highlight included. At 1280 with a thread open the column covers the page's right margin; that comes with the owner's choice to grow a thread to `large`, and is accepted.

**Docs' comment text.** A click on a comment's own text in the page opens its thread and leaves the caret where it landed. It does not select the anchor, as the list and the activity do: a selected anchor would make the next keystroke replace the commented text.

**Open and close.** A click opens; X, Esc and back close. Esc closes unless a dialog or menu is open (the `useDialogOpen` / `useMenuOpen` guard), a text field or editor has the focus (`isTypingTarget`), or a handler before it called `preventDefault`. The column listens on `window`, so every `document` listener hears the key first. One rule decides the order: a handler that uses an Esc calls `preventDefault`, and the column closes on the next Esc; a handler that does nothing with it must not call `preventDefault`. So a drag that cancels on Esc wins, the canvas claims the Esc that cancels a gesture, deselects or drops back to the select tool, and a list claims the Esc that clears a selection of two or more rows. Two handlers change to fit it. The canvas' Esc handler in `CanvasEditor` uses the key today without calling `preventDefault`, so it starts to call it whenever it acts. `useKeyboardListNavigation` calls `preventDefault` on every Esc while a list that passes a `selection` has the focus (Mail's list, Contacts' `PersonList`), even with nothing to clear, so it narrows to a selection of two or more rows: a single selected row is the one a click opened, so the column's Esc closes it instead. Drive's list passes no `selection` to it and takes no Esc. A focused canvas with nothing to cancel lets the column close; the prototype's extra check on a focused `canvas` element goes. Esc closes the whole column, from a thread too: Esc means Close, like X, and `‹ Comments` is the way back to the list.

A press on empty space closes nothing, except on the calendar grid, where the grid is the list (owner's ruling). While the detail is open a click on empty grid only closes it, and the click is swallowed so it doesn't create. A drag on empty grid still creates: it closes the detail and opens New event over the range. A click in the all-day lane is a click. The prototype swallowed the drag too; the build must not.

**URL.** Each host keeps its own param and its existing link names: `?mailId=`, `?contactId=`, `?userId=`, `?teamId=`, `?entryId=`, `?pid=` (+ `uid`, `mid`), `?eventId=`. Comments use the names that exist: the open thread is `?chat=`, the name copy link writes (`getDriveShareUrl(path, { chat })`) and every editor route already reads (`{ chat, q }`); it already opens a deleted comment. `?card=` stays Stickies' own. The list level is one `?panel=comments` or `?panel=activity`, one slot, as `useDocumentPanels` holds one. `?chat=` alone means the thread with the comments list behind it. A `?chat=` landing opens the column straight at `large` with a `LoadingState` while the card syncs; a `?chat=` that names no comment lands on the list by replace. Today `?chat=` is read once on landing (`initialChatName` into `useOpenOnLanding`) and never cleared on close. In the build the open thread is the URL's `?chat=` itself (section 5), so a second notification click opens its comment because the URL changed, and close clears it.

**History.** Opening from closed pushes, so a phone's back closes. A switch to another item replaces: Drive's arrow keys (today each one pushes a `?pid`, through `shouldNotify`), another event, list to thread inside the comments column. Close goes back when the entry is our own push and otherwise replaces, so X and back do the same thing and back after X doesn't reopen the item. A deep link is not our push, so close replaces there. "Our own push" is a flag in the history entry's state, written with the push (section 5). The browser keeps an entry's state across a reload, so after a reload on our own push close still goes back, to the entry before the open, which is the same page closed. Closing removes only its own params, so Mail keeps its `?q=`. In the comments column `‹ Comments` goes to the list by replace, and a phone's system back closes the column from either level.

**Calendar.** The URL is the open state: `?eventId=` and, for an occurrence of a series, `?occurrence=` with its `occurrenceDate`, the key that stays when that occurrence moves. The detail shows the occurrence the current list holds for that pair. While the URL names it, the detail keeps the last copy it found when the list lacks it: during a save, during a refetch and after a week change to a range that doesn't hold it. Only a landing or a reload that never found it shows the not-found state below. A bare `?eventId=` on a series, with no `?occurrence=`, is what Mail's invitation link and a notification's link write today (`calendarEventLink` names only the event and a day): it opens the occurrence in the loaded view nearest the view's `$date` (the day the link's `?date=` becomes) and replaces the URL with that occurrence's key, since the link's day is the only hint of which occurrence was meant; with none in view it shows the not-found state, as any event does. After a drag of the open event the URL stays valid (the id and the key don't change) and the detail follows the list. After an edit or an RSVP the detail stays open on the saved event, where today the dialog closes; a delete closes it. A save that re-keys the occurrence (a series moved at "all", or a split at "this and following", which creates a new series) replaces the URL with the saved event: `EditEventDialog` and `EventDropHost` hand it back through an `onSaved`, and the route writes its key, or closes the detail if nothing matches. After a week change the detail stays while the URL names it: every view navigation keeps `eventId` and `occurrence`. Today each one drops the search, and the build fixes them all: `useShowView` (the toolbar's arrows, Today and view switch, its keyboard shortcuts, and the mini month's day click inside a view), the day-header `Link` in `TimeGrid`, the day-number `Link` in `MonthView`, and the sidebar's view items in `CalendarSidebar` (`SidebarItem` to `/view/$mode/$date`). The start page's redirect in `routes/index.tsx` keeps `eventId` but knows no `occurrence`, so its `validateSearch` and its redirect take `occurrence` too. The mini month outside a view navigates to `/` with only a `?date=`, but no detail is open there. A column is a place you read while you look around, such as checking next week against an invitation; Google closes its peek, but a peek covers the grid and a column doesn't. An event the view can't find, such as on a reload on a week without it, shows the not-found `EmptyState` in the column ("This event isn't in this view"); it doesn't close itself, because shared calendars load separately and the event may still arrive. The open event's block carries a ring in its calendar's colour, so the user sees which block the column describes.

**Phone.** Exactly as Mail: the detail replaces the screen, with the back arrow, and the system back gesture closes it. A main that must survive (an editor, the calendar grid, the board) stays mounted and is hidden with CSS, so an editor keeps its Y.Doc. Lists may keep unmounting, as they do today. Docs keeps its own phone hide rather than `PhoneDetail`, because its outline pane shares that hide.

**Tools while a detail is open.** The detail takes the right slot; a right tool yields while it is open, as comments replace properties today. A left tool (the rail, the Docs outline) stays. Slides refits its slide as the column grows into a thread (816 → 736 at 1440); Vector's canvas narrows from the right.

**Revealing an anchor.** A thread opened from the list or the activity reveals its anchor. In the prototype Vector panned about 800px to do it. The build pans only when the anchor would sit under the column, and then by the least distance that clears it.

**Focus.** A thread opened by a click focuses its composer. A landing or a reload doesn't, so the reply box doesn't look focused on a page the user hasn't touched. While the focus is in the column, the editor's typing, its keymaps and the app's shortcuts beside the detail stand down: `useFocusInDetail()` joins `useDialogOpen()` in their `enabled`. The app shortcuts are calendar's view keys (`useCalendarShortcuts`, enabled from `CalendarToolbar`) and the Yjs undo keys (`useYjsUndoHotkeys`, from Stickies' board and the canvas' `useCanvasKeyboard`), so ⌘Z in a reply box doesn't undo the board or the slide. The command palette's ⌘K (`usePaletteShortcuts`) and Print (`GlobalHotkeys` in `eigen-app.tsx`) stay on everywhere, as they do over a dialog. Mail's shortcuts (`useMailShortcuts`) act on the open message, so they stay on in Mail's detail.

## 5. The technical shape

All in `packages/ui`, exported from its barrels; nothing carries a permission check. `useDetailHistory` calls `useRouter()` itself, as `topbar.tsx` does. The prototype proved this API; the build keeps it, with the history flag below in place of the prototype's entry key.

```tsx
// The frame: the bar and the scrolling body, with the Esc rule. Its host picks medium (beside a surface), large
// (Drive's detail, or a comment thread) or flex (beside a large list, as in Mail, Contacts and Admin).
<DetailColumn
    width="medium"               // 'flex' | 'medium' | 'large'
    title?="Comments"            // only over a list
    onBack?={toList}             // in-column back (thread → list); the phone's arrow runs onBack ?? onClose
    actions={…}
    onClose={close}
    fill?                        // the body scrolls itself, such as a thread over its pinned composer
>
    {body}
</DetailColumn>

// The phone push: on a phone, hides its children with CSS and shows the detail full screen. On a desktop it renders
// its children, and the host puts the detail in its own right slot.
<PhoneDetail detail={detail}>{main}</PhoneDetail>

const { open, close } = useDetailHistory(value, setValue);  // the history rule over the host's own URL value
// setValue(next, { replace, state }): the host passes both to its own navigate
const focusInDetail = useFocusInDetail();                   // folded into a keymap's enabled, beside useDialogOpen
const px = useColumnWidthPx('large');                       // columnWidthPx(size, isTablet) outside React
```

`DetailColumn` has no footer slot. A thread's composer belongs to `CommentThread` and its chat hook, so the column gives the thread a `fill` body, and the thread scrolls over its own pinned composer. It wraps its `Column` in a `data-slot="detail-column"` element with `display: contents`, which `useFocusInDetail` and the tests find it by.

`PhoneDetail` replaces the hide-the-editor-and-mount-outside copies in sheets `editor.tsx` and `CanvasDocumentShell`. Docs keeps its own hide in `editor.tsx`, which its outline pane shares. It keeps the main's element tree identical whether the detail is open or not (a class toggles, no wrapper swaps), so an editor never remounts.

`useDetailHistory(value, setValue)` in `packages/ui/src/hooks/` gives `{ open(next), close() }` with the history rule. It takes the host's own typed value and a setter its route writes, `setValue(next, { replace, state })`, which the host passes straight to its `navigate`, so the value stays the host's and no key-generic helper needs a cast. It can't tell "our own push" from its arguments, so the push carries it: TanStack Router's `navigate` takes a `state`, and on an open from closed the hook calls the setter with `replace: false` and a `state` that writes a `detailPush` flag into the new entry; a switch calls it with `replace: true` and `state: true`, which keeps the entry's state, flag or none; a close that replaces passes `state: true` too. Close reads `router.history.location.state` from `useRouter()`, which the hook calls itself as `topbar.tsx` does (`leave-guard.tsx`, `sidebar-container.tsx` and `app-shell.tsx` import the router too), and on our own push calls `router.history.back()`. The flag is read by narrowing `unknown` (`typeof state === 'object' && state !== null && 'detailPush' in state`), so no cast and no module augmentation. The prototype instead noted the router's entry key (`window.history.state.key`) in a ref after its push; that worked but needed a ref and a second render to catch the router's late commit, and a memory history writes no key to `window.history`, so no test could reach the back path. A flag in the router's state is also there in a memory history, so a route test pins open and close; the real back path still needs one test on a browser history. Mail's compose (`mode`, `composeSessionKey`) stays Mail's, outside the hook.

`useFocusInDetail()` joins `useDialogOpen()` in each document keymap and in the app shortcuts section 4 names (`useCalendarShortcuts`, `useYjsUndoHotkeys`), so Vector's Delete, Docs' typing, the sheet's cell keys, calendar's view keys and ⌘Z on the board stand down while the focus sits in the column. The prototype wired it into the canvas keymaps only (`CanvasEditor`); Docs, Sheets and the app shortcuts are the build's.

Comments:

- `CommentsColumn` replaces `PanelColumn`: list, activity and thread levels in one `DetailColumn`, `medium` at the list and `large` in a thread. `CommentPanel` and `ActivityPanel` drop their `PropertiesPanel` shell (`PanelColumn` cancels it today with `w-full border-l-0`). The list stays mounted under a thread, `invisible` (not unmounted, not `display: none`), so `‹ Comments` finds its scroll. At 400 the hidden list re-wraps, so its scroll offset can drift by a few rows; the build keeps the list at 320 inside the 400 column, so its rows never re-wrap.
- `CardDialog` splits into `CardDetail` and a thin dialog around it. `CardDetail` is a render prop: it hands its host `{ title, deleted, actions, body, editForm }` and the host picks the frame. The board's dialog shows `editForm` in place, as today, so the board shows no change; the column shows it in a `Dialog`, matching "a dialog when you edit or create". `CardFormDialog` is create-only (New comment, a board's Add card); Edit never was it.
- One source for the open thread. When `?chat=` is in the URL, only the URL closes the thread: the prototype's first try closed the card directly, which raced the router and wrote the old `?chat=` back. A delete clears `?chat=` by replace. Every open goes through the column, so a thread opened from a menu, such as the comment menu's Edit, writes `?chat=` like a click. A card with no chat (`chatName` is optional on `CommentCard`) has nothing to link: it opens in the column at `large` without a URL entry, a reload drops it, and close just clears it.
- Choice: the lifecycle reads the open card from the host's URL value, and the column decides the frame. `useCommentLifecycle` takes a `chat` (the route's `?chat=`) in place of `initialChatName`, which goes, and holds no open card for it: while `chat` is set, the open comment is the card that holds that chat name (`findCardIdByChatName`), else the comment index row with that name from `useComments`, which is how a deleted comment named by `?chat=` opens as deleted, as `openChat` does today. Once the cards have synced and `useComments` is no longer pending, a `chat` that finds neither calls `onChatNotFound` once, and the host lands on the list by replace. `useOpenOnLanding` then serves only Stickies' `?card=`. Its own open state stays for what has no `?chat=`: a click on the board, a `?card=` landing, a card with no chat; `chat` wins while the URL has one. `CommentLifecycleDialogs` keeps the context menu and the delete confirm but no longer renders the card; the board renders its own `CardDialog`. That removes the prototype's `cardInColumn` flag.
- Stickies keeps its dialog, on the same source. Its route already reads `chat` and `card` (`eigenDocEditorValidateSearch`) and passes `chat` to `StickiesBoard`, which hands it to the lifecycle, so a `?chat=` landing, an activity row and the palette's comment search open the board's `CardDialog` from the URL, and closing the dialog clears `?chat=` through `useDetailHistory`. A `?card=` landing opens the dialog through `useOpenOnLanding` as today and clears `?card=` by replace (`handleClearCard`).
- `useCommentsColumn` lives beside `CommentsColumn` in `packages/ui/src/components/comments/use-comments-column.ts`, as in the prototype; it can't go to `packages/lib` because it builds on `useDetailHistory`, which is ui's. It needs only the URL value, its setter, the Y.Doc's cards (`useCommentCards`) and the comment index (`useComments`, for a deleted comment), all there before the editor, so Docs builds it before its extensions and selection panel and they call it directly. That removes the prototype's `columnRef` in Docs, which existed because the extensions were built before the lifecycle. A reveal is the caller's: the list and the activity pass one; an anchor's own click doesn't.
- The composer takes the focus only when the thread opens from a click, not on a landing or a reload.

Order, each merge leaving the app whole:

1. **First merge**: `column-widths.ts` with `Column`'s strict tokens, and with them every `Column` caller section 2 lists, so these widths change here: Contacts' and Admin users' and teams' list to `large` (400, 320 on a tablet), the waitlist and Drive's detail to 320 on a tablet, the Docs outline to 256, Docs' `'w-full'` to `flex`; `PropertiesPanel` and `SidebarContainer` take their width from `small` (no visible change). Then `DetailColumn`, `PhoneDetail`, `useDetailHistory`, `useFocusInDetail`, and the canvas' Esc handler calling `preventDefault` when it acts (section 4); the `CardDetail` split; Calendar (event detail in the column, URL, phone push, the open event's ring, `onSaved`; `EventDetailDialog` becomes an `EventDetail` body, `useEventDetailState` moves to the route, and `scripts/dialog-footer.ts` drops `apps/calendar/src/components/event-detail-dialog.tsx` from its list, or `bun scripts/check-standards.ts` fails); `CommentsColumn` in `CanvasDocumentShell` (Slides and Vector in one file) with `?panel=` and `?chat=`. The owner checks it at 1280 and 1440 before the rest follows.
2. Docs: `CommentsColumn` in the overlay slot, the intrusion and find-bar inset from the live width, the URL, `useFocusInDetail` in its typing.
3. Sheets: the `Workbook` slot, `FloatingObjectPanel` into it, `CommentsColumn`, the URL.
4. Stickies' activity in `CommentsColumn`, which then works on a phone; `PanelColumn` goes.
5. The list apps onto `DetailColumn` and `useDetailHistory`: Mail, Contacts (through `ListDetailLayout`), Admin users and teams (the same), and the waitlist. This is the step that delivers their part of sections 1 and 8: Esc closes, the history rule (back after a close doesn't reopen the item), Mail's X, Mail's close keeping `?q=`. Their detail stays `flex` beside the `large` list. It also narrows `useKeyboardListNavigation`'s Esc to a selection of two or more rows (section 4), since Mail's and Contacts' lists are the first to sit beside a `DetailColumn`; Contacts' section headings in `ContactDetailCard` become `eigen-section-label` without the rule (Drive's vCard preview shares the card, so it changes too); the waitlist's Reject is no longer an X, and its "Select an entry" placeholder column goes, so nothing selected shows no detail.
6. Drive onto `DetailColumn` and `useDetailHistory`: its share, watch and ⋮ into the bar, arrow keys replacing; and Slides' rail to `small`, its width from `small` as above.
7. Docs in the same cycle as each step: LAYOUT.md (the detail rule, the widths, the placement rule), COMMENTS.md, MOBILE.md, the help-center articles on comments and calendar, CHANGELOG.
8. Later, optional cleanup: Mail's and the waitlist's inline list layouts into `ListDetailLayout`. Separate from step 5, which changes their behaviour, not their layout code.
9. Later, its own product unit: the stickies list view, under `Board` so the Y.Doc provider stays above both views, a sticky in `CardDetail` in the column.

Mail's missing X is a small fix that can ship any time before step 5, which then moves it into `DetailColumn`.

### Size

Counted from the files on `develop`; nothing reuses preview code. Rough, about ±30% a row. The prototype column is the throwaway prototype's own source lines, tests left out; its in and out count moved code twice, so only its net informs the estimate. It ran low on the primitives, the `CardDetail` split and `CommentsColumn`, so those rows went up. Tests come on top, about 330 lines (focus, remount, history with a browser back path, the Esc order, the calendar URL with a bare `?eventId=` on a series and the grid's click and drag, `?chat=` on a deleted comment, the list apps' close).

| Step | In | Out | Net | Prototype net |
|---|---|---|---|---|
| 1. Widths with every `Column` caller converted, `DetailColumn`, `PhoneDetail`, the two hooks, the canvas' Esc | ~250 | ~40 | +210 | +203 (it converted the callers too) |
| 1. `CardDetail` split as a render prop | ~60 | ~15 | +45 | +45 |
| 1. Calendar in the column (the dialog frame, `useEventDetailState` and three view mounts out; ring, `onSaved`, links in) | ~150 | ~130 | +20 | −1 |
| 1. `CommentsColumn` and the URL in Slides and Vector (`PanelColumn` still serves the others) | ~280 | ~40 | +240 | +266 (with `cardInColumn`, the menu path left out) |
| 2. Docs | ~40 | ~30 | +10 | +14 (with `columnRef`) |
| 3. Sheets | ~30 | ~30 | 0 | not built |
| 4. Stickies' activity; `PanelColumn` and the two `PropertiesPanel` shells out | ~15 | ~140 | −125 | not built |
| 5. List apps onto `DetailColumn` and `useDetailHistory` (Mail, `ListDetailLayout`, the waitlist; the list Esc, Contacts' headings) | ~50 | ~50 | 0 | not built |
| 6. Drive onto `DetailColumn` (`DriveDetailToolbar` and its back handlers out), Slides' rail | ~25 | ~50 | −25 | not built |
| Mail's X | ~5 | 0 | +5 | not built |
| **Total** | ~905 | ~525 | **about +380** | |
| 8. Later: list layouts into `ListDetailLayout` | ~10 | ~100 | −90 | |

The design grows the code by a few hundred lines. What it buys is behaviour: links, back, the phone push and one placement, not fewer lines.

## 6. Comments specifically

**One column that holds the list and drills into a thread, with a back arrow to the list** (owner). The column is `medium` at the list and grows to `large` in a thread. The toolbar's comments icon opens the column at the list (`?panel=comments`). A click on a comment in the list, or on its anchor in the document (a highlight in Docs, a cell marker in Sheets, the corner marker on a canvas), opens the thread in the same column (`?chat=`); `‹ Comments` goes back to the list with its scroll kept. Entered from an anchor, the list is still behind the thread, as Mail's list is behind a message opened from a link. Activity is the same column at another list level; an activity row opens its thread with back to the activity. New comment stays `CardFormDialog`; Edit stays a dialog, the card's own edit form (`CardDetail`'s `editForm`), since `CardFormDialog` is create-only. The hover card on anchors stays. On the stickies board, an activity row opens the sticky in the board's dialog, as today.

Why not a thread beside the list: 256 + 320 at the right is 576px, which in Slides leaves the slide a narrow strip on a laptop. Why not keep the dialog: it is the one item in Eigen that opens in a modal while every other item opens in a column, which is what the owner asked to change.

## 7. Decisions (owner, 25 November 2026)

1. **Placement: under the bar that spans the screen.** The app bar in Mail, Contacts, Drive and Calendar; the editor bar in the editors, which stays full width while the detail takes the right slot under it. Not chosen: the detail running to the top, which would fold Docs' formatting row (B, I and U at 1280), hide Slides' and Vector's shape tools up to 1520, and break the shared top edge of Slides' rail and right column.
2. **Docs keeps its overlay**, for properties and the detail alike, so the page stays centred. Not chosen: a sibling column, which would jump the page 160px on every open.
3. **Four sizes: `small` 256, `medium` 320, `large` 400 (320 on a tablet), `flex`.** `medium` for a detail beside a surface (the comments list, the calendar's event), `large` for lists and Drive's detail. Slides' rail moves from 208 to `small`. Not chosen: details at `large` too, which at 1280 leaves the slide 576px and a day column 81px.
4. **Comments: one column, the list drilling into a thread, back to the list.** The column grows from `medium` to `large` while a thread is open. On a phone the column is a screen of its own with a back arrow, as a mail is. New comment stays `CardFormDialog` and Edit a dialog (the record said Edit was `CardFormDialog` too; it never was, that dialog only creates). Not chosen: a thread beside the list (576px at the right), or keeping the dialog.
5. **The list level is in the URL**: `?panel=comments` or `?panel=activity`, beside `?chat=` for the thread, so a phone's back closes the column and a reload keeps it.
6. **The stickies board keeps its dialog.** A sticky opens in the column only in the future list view.

## 8. Risks

**Size:** about 9 units (the first merge is four, then Docs, Sheets, Stickies' activity, the list apps, and Drive with Slides' rail) plus the docs pass; about +380 lines, tests on top (the prototype raised it from +165). The stickies list view is a unit of its own, later.

**What could regress:**

- Focus in collab editors: a thread in a column has no focus trap. Opening a thread by a click focuses its composer. Document keymaps today stand down only while a dialog is open, so Vector's Delete would delete the canvas selection while focus sits on the thread's Resolve button. `useFocusInDetail()` in each keymap and a test per editor (Vector's Delete, Docs' typing, the sheet's cell keys, an app shortcut such as calendar's view keys or ⌘Z on the board) pin it. The prototype wrote none of these tests, and wired the canvas keymaps only.
- Remounting: the editor must not remount as the column opens or closes, or the Y.Doc session and undo go. `PhoneDetail` keeps the main's tree fixed; a test opens and closes the column around a live editor and checks the instance survives. The prototype saw no remount in the browser but wrote no test.
- Docs' page at 320 and 400: pixel-gate a paged and a pageless doc at 1280 and 1440, the list and a thread open and closed, and with a properties panel open before the column; check the find bar's inset.
- The column growing into a thread: the main reflows by 80px as a thread opens and closes (Slides refits its slide, Sheets remeasures, Docs' page moves at 1280). The editor must not remount on either step, and a thread opened straight from an anchor opens at `large` without passing through `medium`.
- Sheets' slot: the grid must remeasure as the slot opens; the format row no longer folds when a pane opens.
- Esc order: a test per kind pins that an Esc a handler uses doesn't close the column and the next one does (a drag cancelled on Esc, a canvas deselect, a list clearing two selected rows), and that an Esc no handler uses closes it at once (a focused canvas with nothing selected, a list with only the open row selected).
- History: close goes back only after our own push; a deep link replaces. Route tests pin both on a memory history, which keeps the `detailPush` flag, and Drive's arrow keys replacing, and the list apps' close: Mail keeps `?q=`, and back after X doesn't reopen the message, contact, user, team or entry. The back path itself (X after a push, the system back, X after a reload) needs one test on a browser history; the prototype had none, and its memory-history tests could only ever replace.
- Calendar: the grid narrows by 320 on open; month view's "+N more" counts change with it. A save that re-keys the open occurrence must land on the right one, through `onSaved`. A drag on empty grid must still create while the detail is open, and a click must not; the prototype swallowed both, so a test drags over empty grid with the detail open and expects New event over the range, and clicks and expects only a close. Every view navigation section 4 names must keep `eventId` and `occurrence`, the start page's redirect included; a test per kind. A bare `?eventId=` on a series must open the occurrence nearest the view's day and write its key; a test lands on a week with two occurrences, and on a week with none for the not-found state. A save, a refetch and a week change must keep the last copy on screen.
- Comments: a `?chat=` that names a deleted comment must open it as deleted, which needs `useComments` to have loaded before the not-found rule runs; a test lands on one. A `?chat=` landing on the stickies board must still open its dialog, and a `?card=` landing too.
- Widths: Contacts' and Admin's list grows to 400 on a desktop and drops to 320 on a tablet; the waitlist and Drive step to 320 on a tablet. Check the rows' second line still fits at 320.

**Bugs this design removes:** Mail's missing X; the waitlist's X meaning Reject and its placeholder column; the calendar's `?eventId=` read once (`didAutoOpen`), never written, never cleared, back not closing, and the first occurrence of a series opening; `?chat=` never cleared in Docs, Sheets, Slides and Vector, so a reload reopens the comment; Drive pushing a history entry per arrow key; Stickies' missing activity on a phone (the ROADMAP "Mobile: next round" row); `PanelColumn` placed three ways; the panel inside a panel; Drive's 400 on a tablet and nine width literals; Mail's close dropping `?q=`; back after a close reopening the item; Drive's `handleBackToList` comment, which names only the narrow screen's back button though it backs the desktop X too.

**Outside this proposal:** `packages/ui` imports `@tanstack/react-router` in its source (`topbar.tsx`, `leave-guard.tsx` and more) without declaring it in its `package.json`, a pre-existing slip; declaring it is a `package.json` change and needs the owner's yes.
