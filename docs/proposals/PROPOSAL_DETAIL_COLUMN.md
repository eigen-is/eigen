# Proposal: one detail column across Eigen

Ruled on by the owner, 25 November 2026, after a cold review (section 7 holds the decisions). Steps 1 to 6 of section 5's order are built. It grew out of the calendar's event card ([PROPOSAL_CALENDAR_VIEWS.md](PROPOSAL_CALENDAR_VIEWS.md#cards-and-dialogs)): the owner compared a peek beside the event, a panel at the right and today's dialog, and chose the column for an event's content, with dialogs for edit and create. The owner then asked for one design that comments and a future stickies list view share, and for fewer column widths. It rests on an audit of every side column in Eigen. The code claims below were checked against `develop` and the prototype on 25 November 2026, after a cold read caught some that were wrong; the build checks each one again as it reaches it. No route, migration or package is needed.

A throwaway prototype validated the design on 25 November 2026: the widths, the Docs overlay, and the column in Calendar, Slides, Vector and Docs. Its numbers match the tables below (Docs' page left edge at 1440: 323 closed, 323 with the list, 322 with a thread; at 1280: 243, 242, 162). It changed the calendar's not-found case, the history rule's "our own push", the grid's press rule, the Esc order, the `CardDetail` shape and the single source for the open thread, and it found the gaps the sections below now name. A second round the same day made the details look like one design: one body anatomy for an event and a comment (section 3), one shared tile class so board cards and calendar events look the same, "‹" as the one back in every column bar, and Slides' rail back at 208. The owner looked at it in the browser and accepted all four, with the fixes section 3 names (section 7, decisions 7 to 12). The build redoes it on a new branch from this text.

The tile and body anatomy shipped ahead of the column on develop, 25 November 2026: `.eigen-block`, `DetailItemBlock`, `DetailMeta` and `DetailSection` in today's card dialog and comment dialog, and the meta line and sections without the block in the event dialog and the `.ics` quick look.

## 1. The rule in one paragraph

A **detail column** shows one thing the user opened: a message, a contact, a file, an event, a sticky, or a document's conversation (its comments, down to one thread). It opens from a click, the URL names it, and X, Esc or back closes it. It sits at the right, **under the bar that spans the screen**, and carries its own bar. On a phone it replaces the screen with a back chevron ("‹"), exactly as Mail does. It is not the **sidebar** (navigation, AppShell's), not an **always-on tool** (Slides' rail, Slides' and Vector's properties, which frame the editor and have no close), not a **selection tool** (Docs' and Sheets' properties panels, which follow the cursor) and not a **toggled document tool** (the Docs outline). A detail is opened, closed and linked; a tool is part of the editor.

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
- **`small`, 256**: navigation and tools. The sidebar, properties, the outline, and the comments and activity lists, which take turns with properties in the right slot (decision 14). Three of the nine already are 256 (the sidebar, the properties panels and the comments pane); the outline is 240.
- Slides' rail is not a token (the owner's ruling): it keeps a slides-only width, 208 (`w-52`) on normal screens and 256 from 1920 wide (`min-[120rem]:w-64`), where it matches the properties column across from it. Thumbnails read no better wider, so the slide keeps the room.
- **`medium`, 320**: a detail beside a work surface: the calendar's event. The comments and activity lists were `medium` until decision 14 made them `small`.
- **`large`, 400, 320 on a tablet**: a list, or a detail beside a list. Mail's list, Contacts', Admin's and the waitlist's lists, Drive's detail.

On a tablet `large` steps down to 320, so there every column that isn't `small` is 320. The sidebar's 64 rail is a mode of the sidebar, not a width a column picks.

Why 400 for `large` (the owner's ruling): Mail's list, the waitlist and Drive's detail already are 400, so three of its five columns don't change, and Mail already steps to 320 on a tablet, where 320 beside the 64 rail leaves a 1024 tablet a 640 main.

Why a `medium` for a detail beside a surface: a list of rows gives up width easily, a page, a slide, a sheet or a week grid does not. Both widths, worked out from the code at 1440 and 1280 wide (a 16:10 screen):

| Beside the detail | Today (256 pane or none) | Detail at 320 | Detail at 400 |
|---|---|---|---|
| Docs, the page moves by (A4, overlay, section 4) | 0 / 0 | 0 / about 1px | about 1px / about 81px |
| Slides, slide width (`fitFrameViewport`, 24px padding, 208 rail; 928 / 768 with properties) | 928 / 768 with a 256 pane | 864 / 704 | 784 / 624 |
| Vector, canvas width (1184 / 1024 with properties) | 1184 / 1024 with a 256 pane | 1120 / 960 | 1040 / 880 |
| Sheets, default 100px columns in view (about, beside the row header) | 11.4 / 9.8 with a 256 pane | 10.7 / 9.1 | 9.9 / 8.3 |
| Calendar week, a day column (grid less the 56px hour gutter, over seven; no detail today) | 161 / 138 | 115 / 93 | 104 / 81 |

At 1440 both work. At 1280, 400 moves Docs' page 81px on every open, shrinks the slide a fifth below what the properties leave it, and cuts a day column to 81px, where a chip shows a cut-off title. 320 keeps Docs' page in place, the column over its right margin and clear of its text (its clear width is about 1250, so at 1280 it moves about 1px, a few more with a visible scrollbar), costs the slide 64px, and leaves 280px of text inside the 20px gutters: the width of Mail's list on a tablet, room for a thread, its attachment chips and a composer. `small` would leave 216px, too narrow for a thread. The comments list was worked out at 320 here; it is `small` now (decision 14), at the properties panel's 256, so opening it costs the slide nothing the properties didn't, and only a thread takes more.

The calendar's event is `medium`, like the editors' and unlike Drive's: its main is a seven-way grid, a surface, where Drive's main is a list of rows that loses nothing at 400. The rule in one line: `large` beside a list, `medium` beside a surface. One exception, the owner's: an open comment thread is `large`. The comments column is `small` at its list level, the properties panel's width (decision 14), and grows to `large` when it drills into a thread, since reading and writing a conversation needs the room, and steps back to `small` on `‹ Comments`. On a tablet a thread is 320, so it grows 64px there. The growth eases from 256 to 400 in about 200 ms, the thread laid out at its final width so nothing rewraps (owner, 26 November 2026); opening and closing the column stay instant.

### What changes for the user

At 1440 wide unless named.

| Column | Token | Today → after | What the user sees |
|---|---|---|---|
| App sidebar | `small` | 256 → 256 (rail 64) | nothing |
| Properties panels | `small` | 256 → 256 | nothing |
| Docs outline | `small` | 240 → 256 | the outline is 16px wider; it still lies over the page and moves nothing |
| Slides' rail | none, its own | 208 → 208, 256 from 1920 wide | decided by the owner: nothing below 1920; from 1920 the rail matches the properties column across from it |
| Mail's list | `large` | 400 → 400, tablet 320 → 320 | nothing |
| Contacts, Admin users and teams | `large` | 350 → 400, tablet 350 → 320 | the detail loses 50px; on a tablet it gains 30 |
| Waitlist list | `large` | 400 → 400, tablet 400 → 320 | on a tablet the detail gains 80px |
| Drive's detail | `large` | 400 → 400, tablet 400 → 320 | on a tablet the file list gains 80px |
| Calendar's event detail | `medium` | dialog → 320 | new column; the grid narrows by 320 while it is open (day columns 161 → 115) |
| Comments and activity, list level | `small` | 256 → 256 | nothing: the list is as wide as the properties panel it takes turns with, so switching between them keeps the right slot's width; the thread still grows to 400 |
| A comment thread | `large` | dialog → 400 | the column grows 144px from the list as a thread opens (64px on a tablet): the slide 928 → 784 at 1440 (768 → 624 at 1280); in Docs it still lies over the right margin, never the text: the page stays at 1440 and moves about 81px at 1280 |

### One place for the numbers

`packages/ui/src/components/layout/app/column-widths.ts` holds the three numbers and `large`'s tablet step. `Column` takes a strict `width: 'flex' | 'small' | 'medium' | 'large'` and reads `isTablet` from `useLayout()` itself, so no page writes a pixel value or its own tablet branch. A strict type leaves no caller behind, so the step that makes it strict converts every `Column` that passes a pixel value, each in one line: Mail's `listWidth` (`large`), `ListDetailLayout`'s `'350px'` (`large`), the waitlist's `'400px'` (`large`), `DriveLayout`'s `'400px'` (`large`), `PanelColumn`'s `PROPERTIES_PANEL_WIDTH_PX` (`small` until `CommentsColumn` replaces it), the Docs outline's `OUTLINE_WIDTH_PX` (`small`) and Docs' editor's `'w-full'`, which was never a valid width (`flex`). `columnWidthPx(size, isTablet)` and `useColumnWidthPx(size)` give the number to the few hosts that lay out around a column. It replaces Mail's `listWidth`, the literals in `ListDetailLayout`, `WaitlistRoute` and `DriveLayout`, `PROPERTIES_PANEL_WIDTH_PX` and `OUTLINE_WIDTH_PX`. Two widths are classes on plain elements, not a `Column`: the `w-64` in `PropertiesPanel` and the `w-64` in `SidebarContainer` (its `w-16` rail stays, a mode of the sidebar). Each takes its width from `small` as an inline `style`, so one number moves them all; the prototype left both as `w-64`. Slides' rail keeps its own classes in `SlidePanel`, `w-52 min-[120rem]:w-64`, a slides-only width and no token. Docs' `PANEL_INTRUSION_PX` becomes the open right column's live width from `useColumnWidthPx` minus its 16px gutter, so the overlay maths follows a properties panel at `small`, the list at `medium` and a thread at `large`; the outline's `roomStart` reads `small`. The find bar's `right-68` inset (Docs, `CanvasDocumentShell`, and with steps 3 and 4 Sheets and Stickies) becomes that width plus the bar's gutter, as a right inset the host hands `DocSearchProvider`, since a class can't follow a live width.

## 3. The design, visual

### The bar

The rule: **the bar names a list; the body names an item.** A detail bar holds no item title. The item's name is in the body (the item's block, below; Mail's subject and Drive's name as today). A bar over a list (the comments list, the activity feed) shows its title at the left, as every list column does.

- Back is "‹" everywhere: one `BackButton({ onClick, label? })` in `packages/ui` layout/toolbar, a lone chevron with the tooltip "Back", or a chevron with the name of the list it returns to. `Column`'s phone back uses it, so every app's phone back becomes "‹" (it was "←"). Drive's text editor's "Back to files" arrow (`EditToolbar` in `editor-toolbar.tsx`) becomes `‹ Files`, a `BackButton` with the label of where it goes, as `‹ Comments` does; `code-editor-leave.test.tsx`, which clicks it by its old name, follows.
- Left, in a column that has drilled from its list into one item: `‹ Comments`, on a desktop and on a phone alike. It goes to the list.
- Left, on a phone, with no list behind: a "‹" that closes the column, back to the document or the list beside it, labelled with the bar's title if it has one. So the comments column's own list shows `‹ Comments`, the same button as a thread's back, and a column without a title a lone "‹" (the owner's ruling, 26 November 2026: the two backs looked different, and should look the same).
- Right: the item's icon actions, then a ⋮ for the rest, then a gap, then X off the phone. On a phone the back closes, so no X. X always means Close, never Reject. Mail is the exception: its actions start at the left, as they did before the detail column, with the X still at the far right (the owner, 26 November 2026).
- Height `h-12`, `app-gutter-x`, bottom border fading in on scroll (`toolbarBorder="auto"`), as Drive and Mail.

Where today disagrees, this picks: Mail gets its X (it is the only detail without one; a small fix that can ship any time). The calendar's actions move from the dialog footer into the bar, and the body's block says "Lunch". Its RSVP stays in the body, under an `eigen-section-label`: Decline's icon is an X, and in a bar an X only ever means Close. Drive's share, watch and ⋮ move from the body into the bar; its filled Open stays under the heading as the one text button. The comments bar keeps today's order at its list level: "Comments", then `+` (New comment), then the filter, then X. New is there only on a canvas host (Slides, Vector), which adds a comment anchored to no element (`onAddComment` on `PanelColumn` today). Docs and Sheets anchor each comment to their content, so their bar has no New: Docs makes a comment from the Insert menu or the selection's context menu, Sheets from the Insert menu or a cell's context menu.

### The body

- Inset `app-gutter-x`, `pt-4 pb-6`; one scroller, the body. A thread scrolls above a composer pinned to the bottom with a `border-t`; that composer is the thread's own, so the column has no footer slot (section 5).
- The item's title, meta line and sections follow the one anatomy below. Mail's subject and Drive's name keep their `text-xl font-medium` heading, the size the block's title takes.
- Section captions are `eigen-section-label` (small caps), already used by the sidebar sections, Drive's table header, Drive's detail and the comment thread. Contacts' `text-lg` headings with a rule under them are the outlier and change.
- Rows `text-sm`, an icon row (16px muted icon, value, an optional muted second line) for facts, and Drive's label/value rows for metadata.
- Loading: the bar is there at once with its X; the body shows `LoadingState`. Not found: `EmptyState` with the X still there; the calendar's reads "This event isn't in this view". Nothing selected: no column at all (the waitlist's placeholder column goes).
- One 1px `border-l`, top to bottom, bar included. Background `bg-background` in both themes. A document beside it stays white, as LAYOUT.md rules.

### One body anatomy

Every opened item's body is built from three parts in `packages/ui/src/components/layout/app/detail-item.tsx`, so an event and a comment side by side read as one design, in a column or a dialog:

- `DetailItemBlock({ title, color?, children? })`: the item as it looks on its surface, a card on the board or a comment card in a list. Square, in its color's `colorSurface` `'panel'` tone (0.5, paler than a tile, for the reading area), muted (`bg-muted`) without a color. The title is `text-xl font-medium` inside the block; under it the block carries what the item is, such as a comment's text. An event has no block (decision 13): its title is a plain `text-xl font-medium` heading with its time rows under it, and its color stays on the grid's tiles.
- `DetailMeta`: one muted `text-xs` line under the block, such as who made it.
- `DetailSection({ label })`: an `eigen-section-label` caption, 24px above, over `text-sm` rows. With no children it is a caption alone over a list its host draws, such as a thread's messages.

What each detail puts where:

| Detail | Block | Meta | Sections |
|---|---|---|---|
| Calendar event | none: the title as a plain heading, then when, time zone, repeat and the Canceled badge as plain rows | the calendar, and "created by" on a shared calendar | Location, Guests, Description, RSVP |
| Comment thread | title and text | created by … on …, the assignee at the right | Attachments; an Activity caption over the messages; the composer pinned in the `fill` body |
| The board's card dialog | the same anatomy, in a white dialog | | |
| The .ics preview | the event's anatomy, no block | | |

A contact and the future stickies list view follow it too. Known polish for the build: `AttendeeList`'s own "N guests" toggle repeats the Guests caption, so the toggle drops its label.

Every block, tile and event reads one shared class, `.eigen-block`, in `packages/ui/src/styles/globals.css`, after the search ring, which rounds what it rings (`eigen-tile` is taken by Drive's grid): square corners and one flat shadow, `0 1px 2px 0 rgb(0 0 0 / 0.08)`, set through Tailwind's shadow variable so a ring adds to it. In dark mode `colorSurface`'s 2px colored stripe stands in for it. No component keeps its own corner or shadow class: `CardTile` (board cards, the comments list, the hover card, the drag overlay) drops shadcn's `Card`, whose rounding and shadow it only overrode. The hover card's popover keeps its own `shadow-md`, as every floating surface lifts, and the tile inside it is flat, since the popover's `overflow-y-auto` clips the tile's own shadow; `EventSurface` (time-grid blocks, all-day and month bars, chips), the drafts and ghosts (`DraftBlock`, `LaneGhost`) and `DetailItemBlock` read it too. So calendar items and board cards look exactly the same; list rows already were square. The owner chose it flat: in light mode the shadow is barely visible, by design. Drag ghosts and the board's drag overlay no longer look lifted; accepted.

Two tones stay (the owner's correction, 25 November 2026): `colorSurface(color, tone)` keeps its tone, `'tile'` 0.25 for small tiles (board cards, calendar items, comment cards in a list, chips) and `'panel'` 0.5, paler, for `DetailItemBlock`, the block on top of an opened card or comment, for readability. An opened sticky is a white dialog with the card's panel-toned block on top, as a comment is in its column. The owner's answer 5 in [PROPOSAL_CALENDAR_VIEWS.md](PROPOSAL_CALENDAR_VIEWS.md) stands.

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
│ calendars │  MON  TUE  WED  THU  FRI  SAT  SUN       │ ┌ Lunch ─────────┐ │
│ mini month│                 ▌Lunch                   │ │ Thu 3 Dec 12:30│ │
│           │                                          │ └────────────────┘ │
│           │                                          │ 📅 Personal        │
│           │                                          │ GUESTS             │
```

Slides with the comments open: the editor bar spans the screen with its shape tools; rail and detail hang under it with one top edge, the detail in place of the properties:

```
┌ topbar ────────────────────────────────────────────────────────────────────────┐
│ [File Edit Insert     ▭ ◇ ○ ↗ T ▶ 🖼                       🔍 ∿ 🔔 💬 👤+ ] │
│ rail 208 │ slide canvas flex                           │ [Comments    +  ≡  ✕ ] │
│  ▢ 1     │      ┌──────────────────────────┐           │ ┌ test ──────────────┐ │
│  ▢ 2     │      │                          │           │ │ test comment       │ │
│          │      └──────────────────────────┘           │ └ 1 reply ───────────┘ │
```

Closed, Slides is today's layout: the bar over rail, canvas and properties. Docs, thread level: the detail lies over the page's right margin, never its text, as the properties panels do today, and the page stays put:

```
│ [File Edit Insert Format Tools  Normal ▾  B I U …                 🔍 ∿ 🔔 💬 👤+ ] │
│              ┌──────── page, where it was ─────────┐           │[‹ Comments 🔗 ✎ ✓ ✕]│
│              │ adsf                                │           │ ┌ fghjfhgj ───────┐ │
│              │ ▒fghjfhgj▒                          │           │ └ comment text ───┘ │
│              │                                     │           │ Ann · 2 Nov         │
│              │                                     │           │ ACTIVITY  …replies  │
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
│ [≡  list toolbar  ] │  tap → │ [‹       ✎  🗑  ⤓ ] │
│ rows / grid / doc   │ ‹ back │ ┌ Lunch ──────────┐ │
│                     │        │ └ Thu 3 Dec 12:30 ┘ │
└─────────────────────┘        └─────────────────────┘
```

On a phone a comment thread's bar reads `[‹ Comments  🔗 ✎ ✓ ]` and the comments list's own bar `[‹ Comments  ≡ ]`: the same `‹ Comments` button, which closes the column back to the document.

## 4. Behaviour

**Why under the bar, not to the top.** A detail that ran to the top would take its 320 from the editor bar, and the bars have no room to give. Docs folds its icon row by viewport at 1090, 1270 and 1490 (`showsRow`, `showsMiddle`, `showsAll` in `editor-toolbar.tsx`); a bar 320 narrower is 1120 wide at 1440, which would drop the row's middle and end, and 960 at 1280, which would fold the whole row, B, I and U included, the moment a comment opens. The canvas bar folds its shape tools below 1200 (`useIsCompactToolbar`), so Slides and Vector would lose them on any window up to 1520. Slides' rail would start 48px lower than the column beside it. Under the bar, no bar changes, the share cluster and the comments toggle stay where they are, and no bar needs a container query.

**Sheets today, and its step.** Sheets' comments pane and `FloatingObjectPanel` sit beside the whole `Workbook`, bar included, so they run to the top and the bar folds its format row by container width when one opens (`@[1000px]`, `@[1080px]` in `format-toolbar.tsx`). That is today's exception to the rule. The Sheets step moves both into the `Workbook` slot, so the bar stays full width there too. The slot is a `ReactNode` prop on our fork's `Workbook`; the grid already measures its canvas on resize.

**Docs keeps its overlay.** Properties panels and the detail share one right slot in Docs, and both stay an overlay that never reflows the page (`canvasShift`, `canvasScale`): one geometry in the slot. The column may lie over the page's right margin, never its text: that is what `panelClearWidth` guarantees, since it is worked out from the text column's right edge (`textColumnRight`), not the page's. The page moves only as far as the column would otherwise cover text: once the scroller is wider than `panelClearWidth` the panel clears the text and nothing moves. Every "the page doesn't move" below means that. For the default A4 page (text column ending at 718px) that is about 1122 at 256, so at 1280 and 1440 the page doesn't move today. At 320 (`medium`) it is about 1250: the page doesn't move at 1440 and moves about 1px at 1280 (the scroller is the window less its 32px padding, so 1408 and 1248; a visible scrollbar adds about 8px). At 400, the width of an open thread, it is about 1410: the page stays at 1440 and moves about 81px at 1280 while a thread is open. Made a sibling, a 320 column would shift the centred page 160px on every open, a click on a highlight included. At 1280 with a thread open the page moves and the column still covers its right margin; that comes with the owner's choice to grow a thread to `large`, and is accepted.

**Docs' comment text.** A click on a comment's own text in the page opens its thread and leaves the caret where it landed. It does not select the anchor, as the list and the activity do: a selected anchor would make the next keystroke replace the commented text.

**Open and close.** A click opens; X, Esc and back close. Esc closes unless a dialog or menu is open (the `useDialogOpen` / `useMenuOpen` guard), a text field or editor has the focus (`isTypingTarget`), or a handler before it called `preventDefault`. The column listens on `window`, so every `document` listener hears the key first. One rule decides the order: a handler that uses an Esc calls `preventDefault`, and the column closes on the next Esc; a handler that does nothing with it must not call `preventDefault`. So a drag that cancels on Esc wins, the canvas claims the Esc that cancels a gesture, deselects or drops back to the select tool, and a list claims the Esc that clears a selection of two or more rows. Two handlers change to fit it. The canvas' Esc handler in `CanvasEditor` uses the key today without calling `preventDefault`, so it starts to call it whenever it acts. `useKeyboardListNavigation` calls `preventDefault` on every Esc while a list that passes a `selection` has the focus (Mail's list, Contacts' `PersonList`), even with nothing to clear, so it narrows to a selection of two or more rows: a single selected row is the one a click opened, so the column's Esc closes it instead. Drive's list passes its `selection` too, so the same rule holds there: Esc on the one open row closes Drive's detail. A focused canvas with nothing to cancel lets the column close; the prototype's extra check on a focused `canvas` element goes. Esc closes the whole column, from a thread too: Esc means Close, like X, and `‹ Comments` is the way back to the list.

A press on empty space closes nothing, except on the calendar grid, where the grid is the list (owner's ruling). While the detail is open a click on empty grid only closes it, and the click is swallowed so it doesn't create. A drag on empty grid still creates: it closes the detail and opens New event over the range. A click in the all-day lane is a click. The prototype swallowed the drag too; the build must not.

**URL.** Each host keeps its own param and its existing link names: `?mailId=`, `?contactId=`, `?userId=`, `?teamId=`, `?entryId=`, `?pid=` (+ `uid`, `mid`), `?eventId=`. Comments use the names that exist: the open thread is `?chat=`, the name copy link writes (`getDriveShareUrl(path, { chat })`) and every editor route already reads (`{ chat, q }`); it already opens a deleted comment. A card link's `?card=` becomes its card's `?chat=` by replace. The list level is one `?panel=comments` or `?panel=activity`, one slot, as `useDocumentPanels` holds one. `?chat=` alone means the thread with the comments list behind it. A `?chat=` landing opens the column straight at `large` with a `LoadingState` while the card syncs; a `?chat=` that names no comment lands on the list by replace. Today `?chat=` is read once on landing (`initialChatName` into `useOpenOnLanding`) and never cleared on close. In the build the open thread is the URL's `?chat=` itself (section 5), so a second notification click opens its comment because the URL changed, and close clears it.

**History.** Opening from closed pushes, so a phone's back closes. A switch to another item replaces: Drive's arrow keys (today each one pushes a `?pid`, through `shouldNotify`), another event, list to thread inside the comments column. Close goes back when the entry is our own push and otherwise replaces, so X and back do the same thing and back after X doesn't reopen the item. A deep link is not our push, so close replaces there. "Our own push" is a flag in the history entry's state, written with the push (section 5). The browser keeps an entry's state across a reload, so after a reload on our own push close still goes back, to the entry before the open, which is the same page closed. Closing removes only its own params, so Mail keeps its `?q=`. In the comments column `‹ Comments` goes to the list by replace, and a phone's system back closes the column from either level.

**Calendar.** The URL is the open state: `?eventId=` and, for an occurrence of a series, `?occurrence=` with its `occurrenceDate`, the key that stays when that occurrence moves. The detail shows the occurrence the current list holds for that pair. While the URL names it, the detail keeps the last copy it found when the list lacks it: during a save, during a refetch and after a week change to a range that doesn't hold it. Only a landing or a reload that never found it shows the not-found state below. A bare `?eventId=` on a series, with no `?occurrence=`, is what Mail's invitation link and a notification's link write today (`calendarEventLink` names only the event and a day): it opens the occurrence in the loaded view nearest the view's `$date` (the day the link's `?date=` becomes) and replaces the URL with that occurrence's key, since the link's day is the only hint of which occurrence was meant; with none in view it shows the not-found state, as any event does. After a drag of the open event the URL stays valid (the id and the key don't change) and the detail follows the list. After an edit or an RSVP the detail stays open on the saved event, where today the dialog closes; a delete closes it. A save that re-keys the occurrence (a series moved at "all", or a split at "this and following", which creates a new series) replaces the URL with the saved event: `EditEventDialog` and `EventDropHost` hand it back through an `onSaved`, and the route writes its key, or closes the detail if nothing matches. After a week change the detail stays while the URL names it: every view navigation keeps `eventId` and `occurrence`. Today each one drops the search, and the build fixes them all: `useShowView` (the toolbar's arrows, Today and view switch, its keyboard shortcuts, and the mini month's day click inside a view), the day-header `Link` in `TimeGrid`, the day-number `Link` in `MonthView`, and the sidebar's view items in `CalendarSidebar` (`SidebarItem` to `/view/$mode/$date`). The start page's redirect in `routes/index.tsx` keeps `eventId` but knows no `occurrence`, so its `validateSearch` and its redirect take `occurrence` too. The mini month outside a view navigates to `/` with only a `?date=`, but no detail is open there. A column is a place you read while you look around, such as checking next week against an invitation; Google closes its peek, but a peek covers the grid and a column doesn't. An event the view can't find, such as on a reload on a week without it, shows the not-found `EmptyState` in the column ("This event isn't in this view"); it doesn't close itself, because shared calendars load separately and the event may still arrive. The open event's block carries a ring in its calendar's colour, so the user sees which block the column describes.

**Phone.** Exactly as Mail: the detail replaces the screen, with "‹" at the bar's left, and the system back gesture closes it. A main that must survive (an editor, the calendar grid, the board) stays mounted and is hidden with CSS, so an editor keeps its Y.Doc. Lists may keep unmounting, as they do today. Docs keeps its own phone hide rather than `PhoneDetail`, because its outline pane shares that hide.

**Tools while a detail is open.** The detail takes the right slot; a right tool yields while it is open, as comments replace properties today. A left tool (the rail, the Docs outline) stays. Slides refits its slide as the column grows into a thread (928 → 784 at 1440); Vector's canvas narrows from the right.

**Revealing an anchor.** A thread opened from the list or the activity reveals its anchor, and so does a `?chat=` landing, such as a notification's link or a reload, once the anchor has loaded (owner, 26 November 2026). Vector centers the anchor's shape in the canvas left of the column, once the column has its thread width, at the current zoom (owner, 26 November 2026). It pans even when the shape is already in view, and a shape larger than that area still gets its center at the area's center. The anchor's own click, its comment mark or the hover card, doesn't move the canvas. Slides goes to the anchor's slide.

**Focus.** A thread opened by a click focuses its composer. A landing or a reload doesn't, so the reply box doesn't look focused on a page the user hasn't touched. While the focus is in the column, the editor's typing, its keymaps and the app's shortcuts beside the detail stand down: `useFocusInDetail()` joins `useDialogOpen()` in their `enabled`. The app shortcuts are calendar's view keys (`useCalendarShortcuts`, enabled from `CalendarToolbar`) and the Yjs undo keys (`useYjsUndoHotkeys`, from Stickies' board and the canvas' `useCanvasKeyboard`), so ⌘Z in a reply box doesn't undo the board or the slide. The command palette's ⌘K (`usePaletteShortcuts`) and Print (`GlobalHotkeys` in `eigen-app.tsx`) stay on everywhere, as they do over a dialog. Mail's shortcuts (`useMailShortcuts`) act on the open message, so they stay on in Mail's detail.

**Later option: a peek for events on desktop.** The owner likes Google's peek too: a click on an event opens its details in a card beside the block (create and edit stay dialogs either way). What it gives: the details sit where the click was, so the eye doesn't travel to the right edge. What it costs: a second way to open an event beside the column, rules against the grid's drag, quick create and scroll (the card is anchored to where the block was), it covers neighbouring days, and a phone still needs the column. A throwaway preview built it (`PopoverAnchor virtualRef`, as `comment-hover-card.tsx` does). Not built now; the owner wants to rethink it when the sidebar and column work starts, after using the column.

## 5. The technical shape

All in `packages/ui`, exported from its barrels; nothing carries a permission check. `useDetailHistory` calls `useRouter()` itself, as `topbar.tsx` does. The prototype proved this API; the build keeps it, with the history flag below in place of the prototype's entry key.

```tsx
// The frame: the bar and the scrolling body, with the Esc rule. Its host picks small (a comments list), medium
// (beside a surface), large (Drive's detail, or a comment thread) or flex (beside a large list, as in Mail).
<DetailColumn
    width="medium"               // 'flex' | 'small' | 'medium' | 'large'
    title?="Comments"            // only over a list
    onBack?={toList}             // in-column back (thread → list), "‹ Comments"; on a phone without it "‹ title" runs onClose
    actions={…}
    onClose={close}
    fill?                        // the body scrolls itself, such as a thread over its pinned composer
>
    {body}
</DetailColumn>

// The phone push: on a phone, hides its children with CSS and shows the detail full screen. On a desktop it renders
// its children, and the host puts the detail in its own right slot.
<PhoneDetail detail={detail}>{main}</PhoneDetail>

const { open, close } = useDetailHistory<T>(isOpen, setValue);  // the history rule; the host keeps the item in its URL
// setValue(next, { replace, state }): the host writes next into its URL through its own navigate, passing both on
const focusInDetail = useFocusInDetail();                   // folded into a keymap's enabled, beside useDialogOpen
const px = useColumnWidthPx('large');                       // columnWidthPx(size, isTablet) outside React

// The body's parts (section 3) and the one back.
<DetailItemBlock title="Lunch" color={calendarColor}>{when}</DetailItemBlock>
<DetailMeta>{calendarName}</DetailMeta>
<DetailSection label="Guests">{guests}</DetailSection>
<BackButton onClick={toList} label?="Comments" />
```

`DetailColumn` has no footer slot. A thread's composer belongs to `CommentThread` and its chat hook, so the column gives the thread a `fill` body, and the thread scrolls over its own pinned composer. It wraps its `Column` in a `data-slot="detail-column"` element with `display: contents`, which `useFocusInDetail` and the tests find it by.

`PhoneDetail` replaces the hide-the-editor-and-mount-outside copies in sheets `editor.tsx` and `CanvasDocumentShell`. Docs keeps its own hide in `editor.tsx`, which its outline pane shares. It keeps the main's element tree identical whether the detail is open or not (a class toggles, no wrapper swaps), so an editor never remounts.

`useDetailHistory<T>(isOpen, setValue)` in `packages/ui/src/hooks/` gives `{ open(next), close() }` with the history rule. It asks only whether a detail is open, and the host's setter, `setValue(next, { replace, state })`, writes `next` (or `undefined` on a close) into the host's URL through its own `navigate`, so `T` may be richer than what the URL holds: Drive opens with the selected `DrivePath`, and Mail with a message id or a compose prefill. It can't tell "our own push" from its arguments, so the push carries it: TanStack Router's `navigate` takes a `state`, and on an open from closed the hook calls the setter with `replace: false` and a `state` that writes a `detailPush` flag into the new entry; an open while one is open calls it with `replace: true` and `state: true`, which keeps the entry's state, flag or none; a close that replaces passes `state: true` too. Close reads `router.history.location.state` from `useRouter()`, which the hook calls itself as `topbar.tsx` does, and when `'detailPush' in` that state calls `router.history.back()`. The router types the state as `HistoryState`, so the `in` check needs no cast and no module augmentation. The prototype instead noted the router's entry key (`window.history.state.key`) in a ref after its push; that worked but needed a ref and a second render to catch the router's late commit, and a memory history writes no key to `window.history`, so no test could reach the back path. A flag in the router's state is also there in a memory history, so a route test pins open and close; the real back path still needs one test on a browser history. Mail's compose goes through the hook too: `useMailDetail` wraps it over `?mailId=` and `?mode=compose`, counts a compose as open, and writes each entry's own `prefillDraft`, `forwardedParts` and `composeSessionKey` in its setter's `state`.

`useFocusInDetail()` joins `useDialogOpen()` in each document keymap and in the app shortcuts section 4 names (`useCalendarShortcuts`, `useYjsUndoHotkeys`), so Vector's Delete, Docs' typing, the sheet's cell keys, calendar's view keys and ⌘Z on the board stand down while the focus sits in the column. The prototype wired it into the canvas keymaps only (`CanvasEditor`); Docs, Sheets and the app shortcuts are the build's.

Comments:

- `CommentsColumn` replaces `PanelColumn`: list, activity and thread levels in one `DetailColumn`, `small` at the list (decision 14) and `large` in a thread. `CommentPanel` and `ActivityPanel` drop their `PropertiesPanel` shell (`PanelColumn` cancels it today with `w-full border-l-0`). The list stays mounted under a thread, `invisible` (not unmounted, not `display: none`), so `‹ Comments` finds its scroll. At 400 the hidden list re-wraps, so its scroll offset can drift by a few rows; the build keeps the list at 256 inside the 400 column, so its rows never re-wrap.
- `CardDialog` splits into `CardDetail` and a thin dialog around it. `CardDetail` is a render prop: it hands its host `{ title, deleted, actions, body, editForm }` and the host picks the frame. The board's dialog shows `editForm` in place, as today, so the board shows no change; the column shows it in a `Dialog`, matching "a dialog when you edit or create". `CardFormDialog` is create-only (New comment, a board's Add card); Edit never was it.
- One source for the open thread: the URL. Only the URL opens and closes a thread: the prototype's first try closed the card directly, which raced the router and wrote the old `?chat=` back. Every card has its chat (`chatName` is required on `CommentCard`), so every open writes `?chat=`, a thread opened from a menu, such as the comment menu's Edit, included. A delete of the open comment closes the thread as a close does.
- Choice: the lifecycle derives the open card from the host's URL value, and a ui hook writes the URL. `useCommentLifecycle` takes a `chat` (the route's `?chat=`) and holds no open state: while `chat` is set, the open comment is the card that holds that chat name (`findCardIdByChatName`), else the comment index row with that name from `useComments`, which is how a deleted comment named by `?chat=` opens as deleted. Once the cards have synced and `useComments` is no longer pending, a `chat` that finds neither reads as `missing`. `useCommentHost` (`packages/ui/src/components/comments/use-comment-host.ts`) holds `?panel=` and `?chat=` on one `useDetailHistory` for every host: it opens and closes, closes a missing chat as a close does, turns a landing's `?card=` into its card's `?chat=` by replace, and hands the components the bundle with its opens (`CommentLifecycleBundle`). A closed thread goes back to the list behind it by replace, or closes through the history rule when there is none. `CommentLifecycleDialogs` keeps the context menu and the delete confirm but no longer renders the card; the board renders its own `CardDialog`. That removes the prototype's `cardInColumn` flag.
- Stickies keeps its dialog, on the same source. Its route reads `panel`, `chat` and `card` (`eigenDocEditorValidateSearch`) and passes them to `StickiesBoard`, which hands them to `useCommentHost`, so a `?chat=` landing, an activity row and the palette's comment search open the board's `CardDialog` from the URL. The activity and a card it opened share one history entry: closing the dialog drops `?chat=` by replace and leaves the activity, and closing a card opened with no activity goes back over its push, or replaces on a link.
- `useCommentsColumn` lives beside `CommentsColumn` in `packages/ui/src/components/comments/use-comments-column.ts`, as in the prototype, on `useCommentHost`; neither can go to `packages/lib`, because they build on `useDetailHistory`, which is ui's. It needs the URL value, its setter, the Y.Doc's cards (`useCommentCards`) and the comment index (`useComments`, for a deleted comment), and from the host the lifecycle's `activeCardIds` and `ready`. Docs takes those from `useActiveComments(editor)`, which needs the editor, so Docs builds the column after its extensions, and the comment mark's click and its ⌥⌘M toggle reach the column through refs (`openCommentRef`, `toggleCommentsRef` in `apps/docs/src/components/docs/editor.tsx`). A reveal is the caller's: the list and the activity pass one; an anchor's own click doesn't. A landing reveals once per landed card, when its comment has loaded, so an anchor that comes later moves nothing.
- The composer takes the focus only when the thread opens from a click, not on a landing or a reload.

Order, each merge leaving the app whole:

1. **First merge**: `column-widths.ts` with `Column`'s strict tokens, and with them every `Column` caller section 2 lists, so these widths change here: Contacts' and Admin users' and teams' list to `large` (400, 320 on a tablet), the waitlist and Drive's detail to 320 on a tablet, the Docs outline to 256, Docs' `'w-full'` to `flex`; `PropertiesPanel` and `SidebarContainer` take their width from `small` (no visible change). Then `DetailColumn`, `PhoneDetail`, `useDetailHistory`, `useFocusInDetail`, and the canvas' Esc handler calling `preventDefault` when it acts (section 4); `BackButton` with `Column`'s phone back and Drive's editor back on it, so "‹" lands in every app here; the body anatomy and `.eigen-block` exist already (`DetailItemBlock`, `DetailMeta`, `DetailSection`, every tile, event, draft and ghost on the class), and this step reuses them; the `CardDetail` split, on that anatomy; Slides' rail to `w-52 min-[120rem]:w-64` in `SlidePanel`; Calendar (event detail in the column, URL, phone push, the open event's ring, `onSaved`; `EventDetailDialog` becomes an `EventDetail` body, `useEventDetailState` moves to the route, and `scripts/dialog-footer.ts` drops `apps/calendar/src/components/event-detail-dialog.tsx` from its list, or `bun scripts/check-standards.ts` fails); `CommentsColumn` in `CanvasDocumentShell` (Slides and Vector in one file) with `?panel=` and `?chat=`. The owner checks it at 1280 and 1440 before the rest follows.
2. Docs: `CommentsColumn` in the overlay slot, the intrusion and find-bar inset from the live width, the URL, `useFocusInDetail` in its typing.
3. Sheets: the `Workbook` slot, `FloatingObjectPanel` into it, `CommentsColumn`, the URL.
4. Stickies' activity in a `DetailColumn` of its own, `small`, with `ActivityPanel` at `?panel=activity` through `useDetailHistory`, which then works on a phone; `PanelColumn` goes. Not `CommentsColumn`: Stickies' `?chat=` opens the board's dialog (decision 6), and `CommentsColumn` would draw the thread in the column.
5. The list apps onto `DetailColumn` and `useDetailHistory`: Mail, Contacts (through `ListDetailLayout`), Admin users and teams (the same), and the waitlist. This is the step that delivers their part of sections 1 and 8: Esc closes, the history rule (back after a close doesn't reopen the item), Mail's X, Mail's close keeping `?q=`. Their detail stays `flex` beside the `large` list. It also narrows `useKeyboardListNavigation`'s Esc to a selection of two or more rows (section 4), since Mail's and Contacts' lists are the first to sit beside a `DetailColumn`; Contacts' section headings in `ContactDetailCard` become `eigen-section-label` without the rule (Drive's vCard preview shares the card, so it changes too); the waitlist's Reject is no longer an X, and its "Select an entry" placeholder column goes, so nothing selected shows no detail.
6. Drive onto `DetailColumn` and `useDetailHistory`: its share, watch and ⋮ into the bar, arrow keys replacing.
7. Docs in the same cycle as each step: LAYOUT.md (the detail rule, the widths, the placement rule, "‹" as the one back), COMMENTS.md, MOBILE.md, the help-center articles on comments and calendar, CHANGELOG, SHARED-PRIMITIVES.md through `bun run primitives` for `BackButton`.
8. Later, optional cleanup: Mail's and the waitlist's inline list layouts into `ListDetailLayout`. Separate from step 5, which changes their behaviour, not their layout code.
9. Later, its own product unit: the stickies list view, under `Board` so the Y.Doc provider stays above both views, a sticky in `CardDetail` in the column.

Mail's missing X is a small fix that can ship any time before step 5, which then moves it into `DetailColumn`.

### Size

Counted from the files on `develop`; nothing reuses preview code. Rough, about ±30% a row. The prototype column is the throwaway prototype's own source lines, tests left out; its in and out count moved code twice, so only its net informs the estimate. It ran low on the primitives, the `CardDetail` split and `CommentsColumn`, so those rows went up. Tests come on top, about 330 lines (focus, remount, history with a browser back path, the Esc order, the calendar URL with a bare `?eventId=` on a series and the grid's click and drag, `?chat=` on a deleted comment, the list apps' close).

| Step | In | Out | Net | Prototype net |
|---|---|---|---|---|
| 1. Widths with every `Column` caller converted, `DetailColumn`, `PhoneDetail`, the two hooks, the canvas' Esc | ~250 | ~40 | +210 | +203 (it converted the callers too) |
| 1. `BackButton`, the body anatomy, `.eigen-block`, the panel-toned block, Slides' rail (round 2: the comments' root back, Drive's editor back and the `AttendeeList` label on top) | ~310 | ~270 | +40 | +31 (69bec8c3d +6/−4, 0723f281e +79/−81, 340ccd016 +37/−18, a5cd12f8b +181/−169; tests and SHARED-PRIMITIVES.md included) |
| 1. `CardDetail` split as a render prop | ~60 | ~15 | +45 | +45 |
| 1. Calendar in the column (the dialog frame, `useEventDetailState` and three view mounts out; ring, `onSaved`, links in) | ~150 | ~130 | +20 | −1 |
| 1. `CommentsColumn` and the URL in Slides and Vector (`PanelColumn` still serves the others) | ~280 | ~40 | +240 | +266 (with `cardInColumn`, the menu path left out) |
| 2. Docs | ~40 | ~30 | +10 | +14 (with `columnRef`) |
| 3. Sheets | ~30 | ~30 | 0 | not built |
| 4. Stickies' activity; `PanelColumn` and the two `PropertiesPanel` shells out | ~15 | ~140 | −125 | not built |
| 5. List apps onto `DetailColumn` and `useDetailHistory` (Mail, `ListDetailLayout`, the waitlist; the list Esc, Contacts' headings) | ~50 | ~50 | 0 | built |
| 6. Drive onto `DetailColumn` (`DriveDetailToolbar` and its back handlers out) | ~25 | ~50 | −25 | built: −7 (2e47b04aa +153/−160, tests left out) |
| Mail's X | ~5 | 0 | +5 | not built |
| **Total** | ~1215 | ~795 | **about +420** | |
| 8. Later: list layouts into `ListDetailLayout` | ~10 | ~100 | −90 | |

The design grows the code by a few hundred lines. What it buys is behaviour: links, back, the phone push and one placement, not fewer lines.

## 6. Comments specifically

**One column that holds the list and drills into a thread, with `‹ Comments` back to the list** (owner). The column is `small` at the list (decision 14) and grows to `large` in a thread. The toolbar's comments icon opens the column at the list (`?panel=comments`). A click on a comment in the list, or on its anchor in the document (a highlight in Docs, a cell marker in Sheets, the corner marker on a canvas), opens the thread in the same column (`?chat=`); `‹ Comments` goes back to the list with its scroll kept. Entered from an anchor, the list is still behind the thread, as Mail's list is behind a message opened from a link. Activity is the same column at another list level; an activity row opens its thread with back to the activity. New comment stays `CardFormDialog`; Edit stays a dialog, the card's own edit form (`CardDetail`'s `editForm`), since `CardFormDialog` is create-only. The hover card on anchors stays. On the stickies board, an activity row opens the sticky in the board's dialog, as today.

Why not a thread beside the list: 256 + 320 at the right is 576px, which in Slides leaves the slide a narrow strip on a laptop. Why not keep the dialog: it is the one item in Eigen that opens in a modal while every other item opens in a column, which is what the owner asked to change.

## 7. Decisions (owner, 25 November 2026)

1. **Placement: under the bar that spans the screen.** The app bar in Mail, Contacts, Drive and Calendar; the editor bar in the editors, which stays full width while the detail takes the right slot under it. Not chosen: the detail running to the top, which would fold Docs' formatting row (B, I and U at 1280), hide Slides' and Vector's shape tools up to 1520, and break the shared top edge of Slides' rail and right column.
2. **Docs keeps its overlay**, for properties and the detail alike, so the page stays centred. Not chosen: a sibling column, which would jump the page 160px on every open.
3. **Four sizes: `small` 256, `medium` 320, `large` 400 (320 on a tablet), `flex`.** `medium` for a detail beside a surface (the comments list, the calendar's event; decision 14 moves the comments list to `small`), `large` for lists and Drive's detail. Slides' rail is no token; decision 11 reverses the earlier ruling that moved it to `small`. Not chosen: details at `large` too, which at 1280 leaves the slide 576px and a day column 81px.
4. **Comments: one column, the list drilling into a thread, back to the list.** The column grows from `medium` to `large` while a thread is open (from `small` since decision 14). On a phone the column is a screen of its own with "‹", as a mail is. New comment stays `CardFormDialog` and Edit a dialog (the record said Edit was `CardFormDialog` too; it never was, that dialog only creates). Not chosen: a thread beside the list (576px at the right), or keeping the dialog.
5. **The list level is in the URL**: `?panel=comments` or `?panel=activity`, beside `?chat=` for the thread, so a phone's back closes the column and a reload keeps it.
6. **The stickies board keeps its dialog.** A sticky opens in the column only in the future list view.

After the prototype's second round (owner, 25 November 2026):

7. **One body anatomy.** `DetailItemBlock` (the item as it looks on its surface, square, in its color's `'panel'` tone, the `text-xl font-medium` title inside), `DetailMeta` (one muted `text-xs` line) and `DetailSection` (an `eigen-section-label` caption over `text-sm` rows), for the event (without the block, decision 13), the comment thread, the board's card dialog, the .ics preview, and later a contact and the stickies list view (section 3). It replaces the old heading-and-meta rules. `AttendeeList`'s toggle drops its "N guests" label.
8. **Back is "‹" everywhere.** One `BackButton`: a lone chevron with the tooltip "Back", or a chevron with the list's name. Every app's phone back becomes "‹" (was "←"), the comments thread shows `‹ Comments` on a desktop and a phone, and Drive's text editor's "Back to files" arrow becomes `‹ Files`. On a phone the comments column's own list shows `‹ Comments` too, the same button as a thread's, closing the column back to the document (the owner's ruling, 26 November 2026).
9. **One `.eigen-block` class** for every tile and block, in `globals.css`: square, one flat shadow, the dark-mode stripe in its place. Calendar items and board cards look exactly the same. The owner chose it flat; drag ghosts and the board's drag overlay no longer look lifted, accepted.
10. **Two tones stay** (the owner's correction, 25 November 2026, of an earlier "one tint"). `colorSurface(color, tone)` keeps `'tile'` 0.25 for small tiles and `'panel'` 0.5, the paler one, for `DetailItemBlock`, so the large reading area of an opened card or comment stays readable. An opened sticky is a white dialog with the card's panel-toned block on top, as a comment is in its column. Answer 5 in PROPOSAL_CALENDAR_VIEWS.md stands.
11. **Slides' rail is slides-only**, not a Column token: 208 (`w-52`) on normal screens, 256 from 1920 wide (`min-[120rem]:w-64`), where it matches the properties column across from it. This reverses the earlier ruling that moved it to `small`: a wider rail took room from the slide and its thumbnails read no better.
12. **Docs' overlay, precisely.** The column may lie over the page's right margin, never its text, which `panelClearWidth` guarantees; "the page doesn't move" means that.
13. **An opened event has no block** (owner, 25 November 2026). In a calendar the color only says which calendar an event is on, where a card's or comment's color is one a person picked to mean something. So an opened event, in the event dialog, the edit and create dialogs and the .ics preview, shows its title as a plain `text-xl font-medium` heading, its time rows, the meta line and the captioned sections, with no colored or muted box. Its color stays on the grid's tiles.
14. **The comments and activity list is `small`, the same as properties** (owner, 26 November 2026): in every app the list is 256 like the properties panel it takes turns with, so the right slot keeps its width when you switch; a thread still grows to `large`. This replaces the `medium` list of decisions 3 and 4.
15. **Going to a comment in Vector centers its shape** (owner, 26 November 2026), in the canvas left of the column, at the current zoom, from the list, the activity or a `?chat=` landing alike; the anchor's own click doesn't move the canvas.

## 8. Risks

**Size:** about 10 units (the first merge is five, round 2's anatomy, back, tile class and rail among them, then Docs, Sheets, Stickies' activity, the list apps, and Drive) plus the docs pass; about +420 lines, tests on top (the first prototype raised it from +165 to +380, round 2 by about 40). The stickies list view is a unit of its own, later.

**What could regress:**

- Focus in collab editors: a thread in a column has no focus trap. Opening a thread by a click focuses its composer. Document keymaps today stand down only while a dialog is open, so Vector's Delete would delete the canvas selection while focus sits on the thread's Resolve button. `useFocusInDetail()` in each keymap and a test per editor (Vector's Delete, Docs' typing, the sheet's cell keys, an app shortcut such as calendar's view keys or ⌘Z on the board) pin it. The prototype wrote none of these tests, and wired the canvas keymaps only.
- Remounting: the editor must not remount as the column opens or closes, or the Y.Doc session and undo go. `PhoneDetail` keeps the main's tree fixed; a test opens and closes the column around a live editor and checks the instance survives. The prototype saw no remount in the browser but wrote no test.
- Docs' page at 320 and 400: pixel-gate a paged and a pageless doc at 1280 and 1440, the list and a thread open and closed, and with a properties panel open before the column; check the find bar's inset.
- The column growing into a thread: the main reflows by 144px as a thread opens and closes (64px on a tablet) (Slides refits its slide, Sheets remeasures, Docs' page moves at 1280). The editor must not remount on either step, and a thread opened straight from an anchor opens at `large` without passing through `small`.
- Sheets' slot: the grid must remeasure as the slot opens; the format row no longer folds when a pane opens.
- Esc order: a test per kind pins that an Esc a handler uses doesn't close the column and the next one does (a drag cancelled on Esc, a canvas deselect, a list clearing two selected rows), and that an Esc no handler uses closes it at once (a focused canvas with nothing selected, a list with only the open row selected).
- History: close goes back only after our own push; a deep link replaces. Route tests pin both on a memory history, which keeps the `detailPush` flag, and Drive's arrow keys replacing, and the list apps' close: Mail keeps `?q=`, and back after X doesn't reopen the message, contact, user, team or entry. The back path itself (X after a push, the system back, X after a reload) needs one test on a browser history; the prototype had none, and its memory-history tests could only ever replace.
- Calendar: the grid narrows by 320 on open; month view's "+N more" counts change with it. A save that re-keys the open occurrence must land on the right one, through `onSaved`. A drag on empty grid must still create while the detail is open, and a click must not; the prototype swallowed both, so a test drags over empty grid with the detail open and expects New event over the range, and clicks and expects only a close. Every view navigation section 4 names must keep `eventId` and `occurrence`, the start page's redirect included; a test per kind. A bare `?eventId=` on a series must open the occurrence nearest the view's day and write its key; a test lands on a week with two occurrences, and on a week with none for the not-found state. A save, a refetch and a week change must keep the last copy on screen.
- Comments: a `?chat=` that names a deleted comment must open it as deleted, which needs `useComments` to have loaded before the not-found rule runs; a test lands on one. A `?chat=` landing on the stickies board must still open its dialog, and a `?card=` landing too.
- Widths: Contacts' and Admin's list grows to 400 on a desktop and drops to 320 on a tablet; the waitlist and Drive step to 320 on a tablet. Check the rows' second line still fits at 320.

**Bugs this design removes:** Mail's missing X; the waitlist's X meaning Reject and its placeholder column; the calendar's `?eventId=` read once (`didAutoOpen`), never written, never cleared, back not closing, and the first occurrence of a series opening; `?chat=` never cleared in Docs, Sheets, Slides and Vector, so a reload reopens the comment; Drive pushing a history entry per arrow key; Stickies' missing activity on a phone (the ROADMAP "Mobile: next round" row); `PanelColumn` placed three ways; the panel inside a panel; Drive's 400 on a tablet and eight width literals; Mail's close dropping `?q=`; back after a close reopening the item; Drive's `handleBackToList` comment, which names only the narrow screen's back button though it backs the desktop X too; board cards (a medium shadow) and calendar events (rounded corners) drawn as two apps; a phone back drawn as "←" beside a desktop "‹".

**Outside this proposal:** `packages/ui` imports `@tanstack/react-router` in its source (`topbar.tsx`, `leave-guard.tsx` and more) without declaring it in its `package.json`, a pre-existing slip; declaring it is a `package.json` change and needs the owner's yes.
