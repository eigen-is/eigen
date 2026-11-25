# Proposal: one detail column across Eigen

Draft for the owner, 25 November 2026, not yet ruled on. It grew out of the calendar's event card ([PROPOSAL_CALENDAR_VIEWS.md](PROPOSAL_CALENDAR_VIEWS.md#cards-and-dialogs)): the owner compared a peek beside the event, a panel at the right and today's dialog on a local preview branch, and chose the column for an event's content, with dialogs for edit and create, and asked for one design that comments and a future stickies list view share. It rests on an audit of every side column in Eigen; every code claim below was checked in the code. No route, migration or package is needed.

## 1. The rule in one paragraph

A **detail column** shows one thing the user opened: a message, a contact, a file, an event, a sticky, or a document's conversation (its comments, down to one thread). It opens from a click, the URL names it, and X, Esc or back closes it. It sits at the right of what it was opened from, carries its own bar at the top of the page, and on a phone it replaces the screen with a back arrow, exactly as Mail does. It is not the **sidebar** (navigation, AppShell's), not an **always-on tool** (Slides' rail, Slides' and Vector's properties, which frame the editor and have no close), not a **selection tool** (Docs' and Sheets' properties panels, which follow the cursor) and not a **toggled document tool** (the Docs outline). Tools belong to the editor: they live inside the editor's column, under its bar, at 256px. A detail stands beside the editor, as its own column. That difference is what makes it read like Drive, Mail and Contacts.

The one move this makes: comments and activity leave the tool family and become a detail. The owner grouped "comments and calendar info" with Drive, Mail and Contacts, and their behaviour fits: they are opened, closed and linked, never selection-driven.

## 2. The design, visual

### One width for the narrow column of a pair

Every page that pairs two columns pairs one fixed column with one flex column. The fixed one is **360px** on a desktop and 320px on a tablet, in one constant (`SIDE_COLUMN_WIDTH`): the list in a list app (Mail, Contacts, Admin, the stickies list view), the detail in an aside app (Drive, Calendar, the editors). Tools stay 256 (`PROPERTIES_PANEL_WIDTH_PX`), so a glance at the width says which role a column has.

Why 360: it is the calendar panel the owner liked; it leaves 320px of text inside the 20px gutters, enough for a comment thread with attachment chips and a composer; and at 1280 wide it leaves the calendar grid 664px beside the 256 sidebar. 400 (Drive today) costs every editor 144px over its properties at the right, and Slides' 208 rail would face a column twice its width. Mail's list moves 400 to 360, Contacts' 350 to 360, Drive's detail 400 to 360. Drive's 400 on a tablet, the audit's bug, goes too.

### The bar

The rule: **the bar names a list; the body names an item.** A detail bar holds no item title. The item's name is the body's heading, as Mail, Drive and Contacts already do. A bar over a list (the comments list, the activity feed) shows its title at the left, as every list column does.

- Left: on a phone, `Column`'s back arrow. On any screen, an in-column back (`‹ Comments`) when the column has drilled from its list into one item.
- Right: the item's icon actions, then a ⋮ for the rest, then a gap, then X on desktop. On a phone the back arrow closes, so no X. X always means Close, never Reject.
- Height `h-12`, `app-gutter-x`, bottom border fading in on scroll (`toolbarBorder="auto"`), as Drive and Mail.

Where today disagrees, this picks: Mail gets its X (it is the only detail without one). The calendar's actions move from under the title into the bar, and its "Event" bar title goes, since the body says "Lunch". Drive's share, watch and ⋮ move from the body into the bar; its filled Open stays under the heading as the one text button, the way a primary action is a text button elsewhere. The comments bar keeps "Comments" + filter + New + X at its list level.

### The body

- Inset `app-gutter-x`, `pt-4 pb-6`; one scroller, the body. A thread scrolls above a composer pinned to the bottom with a `border-t`.
- Heading `text-xl font-medium`, as Mail's subject and Drive's name already are. The calendar's `font-semibold` and the card's `text-lg` come in line.
- A meta line under it in `text-sm text-muted-foreground` (date, sender, author).
- Section captions are `eigen-section-label` (small caps), already used by the sidebar sections, Drive's table header, Drive's detail and the comment thread. Contacts' `text-lg` headings with a rule under them are the outlier and change.
- Rows `text-sm`, an icon row (16px muted icon, value, an optional muted second line) for facts like time and calendar, and Drive's label/value rows for metadata.
- Loading: the bar is there at once with its X; the body shows `LoadingState`. Not found: `EmptyState` with the X still there. Nothing selected: no column at all (the waitlist's placeholder column goes).
- One 1px `border-l`, top to bottom, bar included. Background `bg-background` in both themes; dark mode changes nothing else. A document beside it stays white, as LAYOUT.md rules.

### The four kinds of page

List app, Mail, Contacts, Admin, the stickies list view:

```
┌ topbar ───────────────────────────────────────────────────────────────────┐
│ nav 256   │ list 360               │ detail flex                          │
│ Compose   │ [search…            ⋮] │ [ ↩  ↩↩  ↪  🗄  🗑  ⋮           ✕ ] │
│ Inbox     │ row                    │ Bell test new3                       │
│ Drafts    │▌row (open)             │ Bell Tester · 17 Nov, 13:43          │
│ Sent      │ row                    │ Hello from the bell test.            │
└───────────┴────────────────────────┴──────────────────────────────────────┘
```

List and aside, Drive:

```
│ nav 256   │ list flex                              │ detail 360           │
│ New       │ [Drive › folder               ☰  ▦ ]   │ [       👤+  🔔  ⋮  ✕]│
│ Drive     │ NAME                         MODIFIED  │ ┌ preview ─────────┐ │
│ Recent    │▌budget                       2 Nov     │ budget               │
│           │ budget.xlsx                  14 Sep    │ [ Open           ]   │
│           │                                        │ DETAILS              │
```

Work surface and detail, Calendar (the grid is its list):

```
│ nav 256   │ grid flex                                │ detail 360         │
│ Create    │ [Today ‹ › 30 Nov – 6 Dec       Week ▾ ] │ [   ✎  🗑  ⤓    ✕ ]│
│ calendars │  MON  TUE  WED  THU  FRI  SAT  SUN       │ Lunch              │
│ mini month│                 ▌Lunch                   │ 🕒 Thu 3 Dec 12:30 │
│           │                                          │ 📅 Reinder Nijhoff │
```

Editor with tools and an open conversation, Slides (rail and properties are tools, under the editor bar; the detail takes the right in place of the properties and runs to the top):

```
┌ topbar ──────────────────────────────────────────────────────────────────────────┐
│ [File Edit Insert    ▭ ◇ ○ ↗ T ▶       🔍 ∿ 🔔 💬 👤+ ] │ [Comments     +  ≡  ✕ ]│
│ rail 208 │ slide canvas flex                            │ ┌ test ──────────────┐ │
│  ▢ 1     │      ┌──────────────────────────┐            │ │ test comment       │ │
│  ▢ 2     │      │                          │            │ └ 1 reply ───────────┘ │
│          │      └──────────────────────────┘            │                        │
```

Closed, Slides is today's layout: the full-width bar over rail, canvas and properties at 256. Docs, thread level, the page centred in what is left:

```
│ [File Edit Insert Format Tools  Normal ▾  B I U    🔍 ∿ 🔔 💬 👤+ ] │ [‹ Comments  🔗 ✎ ✓  ✕]│
│              ┌──────── page, centred in its column ────────┐       │ fghjfhgj               │
│              │ adsf                                        │       │ “quoted anchor text”   │
│              │ ▒fghjfhgj▒                                  │       │ THREAD                 │
│              │                                             │       │ …replies               │
│              └─────────────────────────────────────────────┘       │ [Reply…             ➤] │
```

Phone, every kind:

```
┌ topbar ─────────────┐        ┌ topbar ─────────────┐
│ [≡  list toolbar  ] │  tap → │ [←       ✎  🗑  ⤓ ] │
│ rows / grid / doc   │ ← back │ Lunch               │
└─────────────────────┘        └─────────────────────┘
```

## 3. Behaviour

**Open and close.** A click opens; X, Esc and back close. Esc closes unless something else took it: a dialog or menu is open (the `useDialogOpen` / `useMenuOpen` guard the calendar's shortcuts use), a text field, editor or canvas has the focus, or a handler before it called `preventDefault` (Drive's list clearing a multi-selection, the canvas deselecting first). A press on empty space closes nothing, except on the calendar grid, where it keeps today's rule (close, and swallow the click so it doesn't create), because there the grid is the list.

**URL.** Each host keeps its own param and its existing link names: `?mailId=`, `?contactId=`, `?userId=`, `?teamId=`, `?entryId=`, `?pid=` (+ `uid`, `mid`), `?eventId=`, `?chat=` and `?card=`. Opening pushes, so a phone's back closes. Closing goes back when the entry was our own push (a flag in history state) and otherwise replaces, so X and back do the same thing and back after X no longer reopens the item. Closing removes only its own param, so Mail keeps its `?q=`. The calendar writes `?eventId=` on a click (plus the occurrence's start for a recurring event, since the id alone picks the first occurrence) and reads it on every change, not once. Comments write `?comments` or `?activity` for the list level and `?card=<id>` for a thread (the copy-link form), and still read `?chat=` from notification links and clear it on close.

**Phone.** Exactly as Mail: the detail replaces the screen, with the back arrow, and the system back gesture closes it. The main stays mounted and is hidden with CSS, in every app, so an editor keeps its Y.Doc and a list keeps its scroll (the rule `AppShell` already follows for the sidebar). Mail and Contacts stop unmounting their list on a phone; nothing depends on that.

**Tools while a detail is open.** The detail takes the right; a right tool yields while it is open, as comments replace properties today. Slides keeps something on each side (rail left, detail right), so the balance holds, with the right 104px wider. A left tool (the rail, the Docs outline) stays.

**The editor bar: change it.** Today the editor bar runs full width and every pane hangs under it, in three different ways (overlay in Docs, beside the whole workbook in Sheets, under the bar in the canvas shell and Stickies). The proposal: the detail is a sibling `Column` of the editor, so it runs to the top with its own bar and the editor's bar narrows, as Drive's list bar narrows beside its detail. Sheets already works this way. Tools stay under the editor bar. This makes the role visible (tools are part of the editor; a detail stands beside it), gives one geometry instead of three, and makes the editors read like every other app. Cost: the share cluster and the comments toggle move left by 360 while the column is open; the docs, slides, vector and stickies bars must fold their icon row by their own width (a container query, as `packages/sheet`'s `MenuBar` does) instead of the viewport's; the find bar's `right-68` inset is needed only for tools. The alternative (keep the full-width bar, hang the detail under it) costs nothing now but keeps two bars stacked at the right, a geometry no other app has, and Docs' overlay maths for comments.

**Docs' overlay: keep it for tools, drop it for the detail.** Docs' properties panels follow the selection and come and go on every click, so they stay an overlay that never reflows the page (`canvasShift`, `canvasScale`). The comments detail becomes a sibling: the page centres in the narrower editor column. At 1440 that column is 1080 wide and an 816 page fits without scaling; today's overlay slides the page left by its overlap anyway, so the page moves about the same.

## 4. The technical shape

All in `packages/ui/src/components/layout/app/` beside `ColumnLayout`, exported from its barrel; nothing in it imports a router or carries a permission check.

```tsx
// The page: one fixed column and one flex column. Replaces ListDetailLayout.
<DetailLayout
    shape="list" | "aside"   // list: main is the fixed list, detail flex. aside: main flex, detail fixed.
    mainToolbar={…} mainToolbarBorder="always"   // the editor's bar, Drive's list bar
    detail={open ? <DetailColumn …/> : null}      // phone: detail only, main hidden with CSS, never unmounted
>
    {main}
</DetailLayout>

// The frame: the bar and the scrolling body. Width from DetailLayout's context.
<DetailColumn
    title?="Comments"            // only over a list
    onBack?={toList}             // in-column back (thread → list); phone's arrow runs onBack ?? onClose
    actions={…}
    onClose={close}
>
    {body}
</DetailColumn>
```

`DetailLayout` keeps the main's element tree identical whether the detail is open or not (a class toggles, no wrapper swaps), so an editor never remounts. It owns the Esc rule above. A small `useDetailParam(route, 'eventId')` in `packages/ui/src/hooks/` gives `{ value, open(id), close() }` with the push-and-back rule; it takes the route by shape, as `EigenDocListView` already does, because neither `packages/ui` nor `packages/lib` depends on the router and adding it would be a package change. State stays the host's: the URL, read in its route.

What it replaces, roughly (lines out / in):

- `ListDetailLayout` (becomes `DetailLayout`), Mail's and the waitlist's inline layouts, `DriveLayout`'s `ColumnLayout` block and `DriveDetailToolbar`, every route's back-to-list handler: about 230 out.
- Calendar: `EventDetailDialog` becomes an `EventDetail` body in a `DetailColumn`; `useEventDetailState` moves to the route, and `?eventId=` becomes the open state in place of the once-only `didAutoOpen` (create stays `CreateEventDialog`, as the owner ruled): roughly even in lines.
- Comments: `PanelColumn` becomes `CommentsColumn` (list, activity and thread levels in one `DetailColumn`); `CardDialog` splits into `CardDetail` (actions and body, no `Dialog`, the deleted state as a body, Edit opening `CardFormDialog`) and the board's `CardDialogFrame` wrapper; `CommentPanel` and `ActivityPanel` drop their `PropertiesPanel` shell; the three hide-the-editor-and-mount-outside copies (docs `editor.tsx`, sheets `editor.tsx`, `CanvasDocumentShell`) and Stickies' activity mount go: about 200 out.
- New: `DetailLayout` + `DetailColumn` about 130, `useDetailParam` about 40, `CommentsColumn` about 90, bar container queries about 30. Net about −140 over some 25 files.

Order, each a merge that leaves the app whole:

1. `DetailLayout`, `DetailColumn`, `useDetailParam`; adopt in Contacts and Admin users and teams (a pure refactor, pixel-gated), then the waitlist and Mail (Mail gains X and keeps `?q=`).
2. Drive: the shared views, the width, actions into the bar.
3. Calendar: event detail in the column, URL, phone push; the dialog frame goes.
4. `CardDetail` split (no visible change on the board).
5. `CommentsColumn` in Slides and Vector (`CanvasDocumentShell`, one place for both), then Sheets, then Docs (the sibling and the overlay split), then Stickies' activity, which then works on a phone. The bars' container queries land with the first editor.
6. Docs in the same cycle: LAYOUT.md (the detail rule, the width, the bar rule), COMMENTS.md, MOBILE.md, the help-center articles on comments and calendar, CHANGELOG.
7. Later, its own product unit: the stickies list view, `shape="list"` under `Board` so the Y.Doc provider stays above both views, a sticky in `CardDetail`.

## 5. Comments specifically

**Recommendation: one column that holds the list and drills into a thread, with a back arrow to the list.** The toolbar's comments icon opens the column at the list (`?comments`). A click on a comment in the list, or on its anchor in the document (a highlight in Docs, a cell marker in Sheets, the corner marker on a canvas), opens the thread in the same column (`?card=`); `‹ Comments` goes back to the list with its scroll kept. Entered from an anchor, the list is still behind the thread, as Mail's list is behind a message opened from a link. Activity is the same column at another list level; an activity row opens its thread with back to the activity. New comment and Edit stay `CardFormDialog`, matching "a dialog when you edit or create". The hover card on anchors stays.

Why not a thread beside the list: 256 + 360 at the right is 616px, which in Slides leaves the slide a narrow strip on a laptop. Why not keep the dialog: it is the one item in Eigen that opens in a modal while every other item opens in a column, which is what the owner asked to change.

## 6. Decisions for the owner

1. **Width.** One 360px (320 on a tablet) for the narrow column of every pair: the list in Mail and Contacts, the detail in Drive, Calendar and the editors; tools stay 256. Alternative: Drive's 400 for details only, leaving lists as they are; cost: every editor loses 144px beside a 208 rail, and the list widths stay four literals.
2. **Editor bar.** The detail runs to the top with its own bar and the editor bar narrows, as in Drive and today's Sheets. Alternative: keep the full-width bar and hang the detail under it; cost: two stacked bars at the right, a geometry no list app has, and Docs keeps its overlay maths for comments.
3. **Comments.** One column, list drilling into a thread, back to the list. Alternative: the list column stays and only the dialog goes, with the thread opening beside it; cost: 616px at the right. Keeping the dialog is the other alternative; cost: the ask unmet.
4. **Comments in the URL.** `?comments` / `?activity` for the list and `?card=` for a thread, so a phone's back closes the column instead of leaving the document. Alternative: React state as today; cost: the phone's back leaves the document, unlike Mail.
5. **Drive's actions.** Share, watch and ⋮ move into the bar; Open stays in the body. Alternative: Drive keeps them in the body; cost: the one detail whose actions sit somewhere else.
6. **Stickies board view.** A sticky on the board keeps opening in a dialog; it opens in the detail column only in the list view. Alternative: the board opens a sticky in the right column too; cost: the board's sideways scroll loses 360px, and a stickies unit sooner than planned.

## 7. Risks and what it costs

**Size:** about 7 units (section 4's six steps plus the docs pass), net about 140 lines removed over some 25 files. The stickies list view is an eighth, later.

**What could regress:**

- Focus in collab editors: a thread in a column has no focus trap. Opening a thread focuses its composer. Document keymaps today stand down only while a dialog is open, so Vector's Delete would delete the canvas selection while focus sits on the thread's Resolve button. Each keymap folds in a `useFocusInDetail()` beside `useDialogOpen()`; a test per editor (Vector's Delete, Docs' typing, the sheet's cell keys) pins it.
- Remounting: the editor must not remount as the column opens or closes, or the Y.Doc session and undo go. `DetailLayout` keeps the main's tree fixed; a test opens and closes the column around a live editor and checks the instance survives.
- Docs' page: the comments sibling changes `containerWidth`, the pageless `--breakout` and the find-bar insets; pixel-gate a paged and a pageless doc at 1280 and 1440, column open and closed, and with a properties panel open before the column.
- The editor bars folding by container instead of viewport; the share cluster moving 360px while open.
- Phone: Mail's and Contacts' lists stay mounted when hidden; a virtualized list must keep its scroll on return (it does for the sidebar today; verify on Mail).
- History: close-goes-back reads a flag in history state; a deep link or a reload has no flag and replaces instead. Pin both in the route tests.
- Calendar: the grid narrows by 360 on open; month view's "+N more" counts change with it.

**Bugs this design removes:** Mail's missing X; the waitlist's X meaning Reject and its placeholder column; the calendar's `?eventId=` read once, never written, never cleared, back not closing, and the first occurrence of a series opening; `?chat=` never cleared in Docs, Sheets, Slides and Vector; Stickies' missing activity on a phone (the ROADMAP "Mobile: next round" row); `PanelColumn` placed three ways; the panel inside a panel; Drive's 400 on a tablet and no shared detail width; Mail's close dropping `?q=`; back after a close reopening the item; Drive's `handleBackToList` comment.
