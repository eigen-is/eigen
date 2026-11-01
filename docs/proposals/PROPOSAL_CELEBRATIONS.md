# Proposal: Celebrations

This proposal adds a small surprise when you finish something in Eigen: a burst of confetti or a cheering stick figure when you tick the last box of a sticky's checklist.

**Status:** Phase 1 is built: `useCelebrate`, the confetti burst, the setting and the checklist trigger ([STICKIES.md](../STICKIES.md#ticking-the-last-box-of-a-checklist-celebrates-now-and-then)). Phases 2 to 4 are not started. The empty states and the new triggers were added on 2026-11-01.

> **TLDR**: One shared `useCelebrate()` hook in `packages/ui` draws a short burst from the point where you finished something, then removes itself. The first trigger is the last checkbox of a sticky's task list, in `NoteCardDialog`. It fires only for your own click, only now and then, and never for a teammate's edit. Later celebrations can show a stick figure from the clipart catalog ([PROPOSAL_CLIPART.md](PROPOSAL_CLIPART.md)) instead of confetti, and the same figures sit in the apps' empty states, which is where a new user meets them first. One personal setting turns the celebrations off. No package, no new route, no migration.

## Why

A sticky card already shows a progress bar and a `3/5` count for its task list (`NoteCard`, `packages/ui/src/components/notes/note-card.tsx`). You watch it fill up, and then nothing happens when it's full. A small reward at that moment makes Eigen feel a bit warmer than an admin tool, and it costs an afternoon.

The apps that do this well (Asana's flying unicorn, Apple's activity rings, Things' checkbox) share a few habits. The reward lands on the click that earned it. It is rare enough to stay a surprise. And it is easy to switch off. The ones that go wrong (Duolingo's streak guilt) turn it into points and pressure. This proposal copies the first group and avoids the second.

## Non-goals

- Points, streaks, badges, levels or leaderboards. Celebrations are private and never compare people.
- Sound.
- An admin or team setting. If a customer asks to turn it off for a whole organization, that is a one-line addition then.
- Celebrations for something another person did.
- Seasonal decorations. Not everyone celebrates the same holidays, and Eigen doesn't know where a user lives.
- A mascot that talks or interrupts, as Clippy did. A figure never speaks, never moves on its own and never covers the page.

## The rules

1. **Only your own action.** A celebration fires from the click that completed something, in your tab. An edit that arrives from a teammate, a page load or a refetch never fires one.
2. **Only now and then.** Something that just happens to be complete, like a checklist, celebrates with a chance of one in three. A goal you set yourself (the word goal under Later) always celebrates, because you asked for it.
3. **Once per completion.** The chance is rolled once per dialog opening. Unticking and re-ticking the last box in the same dialog does nothing, so it can't be farmed.
4. **Reduced motion is respected.** With `prefers-reduced-motion: reduce`, there is no burst and no hop. The ticked box gives a short glow instead.
5. **One switch.** The personal setting below turns everything off.

## Design

### The burst

`useCelebrate()` in `packages/ui/src/components/celebrate/` returns `celebrate(origin: HTMLElement)`, the element that was clicked. The hook reads the setting and `prefers-reduced-motion`, and applies the chance, so a call site is one line and never checks anything itself.

A burst is a fixed, full-viewport `<canvas>` with `pointer-events: none`, appended to `document.body`. About 80 particles spray up from the top of `origin` and fall under gravity for about 1.5 seconds. Then the canvas removes itself. A second burst while one is running is dropped. It is about 60 lines of our own code. `canvas-confetti` would do the same, but a new package needs its own approval, and this is small enough to write.

### The first trigger: a sticky's checklist

`NoteCardDialog` (`packages/ui/src/components/notes/note-card-dialog.tsx`) toggles a task-list checkbox in `handleDescriptionClick` and passes the new HTML to `onDescriptionChange`. That is where it fires: if the click checked a box, and the list now has at least two items and all of them are checked, call `celebrate(input)`. The confetti comes out of the box you just ticked.

`countTaskItems` (`packages/lib/src/core/html.ts`) counts checked and total items for both `NoteCard` and the dialog. `NoteCardDialog` also serves `CardDialog` (`packages/ui/src/components/cards/card-dialog.tsx`), so cards outside the Stickies app get the same behavior.

A checklist with one item is a toggle, not a list, so it doesn't count.

### Stick people from the clipart catalog

Once the clipart catalog exists, a celebration can be a stick figure instead of confetti: one of the catalog's celebrating poses (cheering, jumping, holding a trophy). It is drawn with `renderClipartSvg` at roughness 1 and a fresh random seed, so the hand-drawn jitter is different every time. It pops up next to `origin`, hops once and fades out after about two seconds. The whole SVG moves with a CSS transform; the limbs don't animate.

When a celebration fires, it is usually confetti. About one in four is a stick figure. This waits on Phase 2 of [PROPOSAL_CLIPART.md](PROPOSAL_CLIPART.md), which adds `layoutClipart` and the stick-people category.

### Stick figures in the empty states

Every app draws an empty view through one component, `EmptyState` (`packages/ui/src/components/layout/app/empty-state.tsx`), which takes an `icon`. A stick figure with one prop goes there, saying what the view is about:

| Empty view | Figure |
|---|---|
| Mail, an empty inbox | Feet up on an empty desk. This is the calm inbox zero: no party, and no trigger to write, since the empty view is the moment |
| A search with no results | The detective with a magnifying glass, shrugging |
| Drive, the Trash | Sweeping with a broom |
| Drive, an empty folder | Holding Schrödinger's box: closed, a question mark on its side, so nobody knows whether anything is in it. It goes with `EmptyState`'s own default line, "Within this void, all possibilities are yet unobserved." |
| Contacts or Chat with nobody in it yet | Waving |

These are illustrations, not celebrations, so the rules above don't apply. A figure is still, and the same each time: its seed comes from the view's name, so it doesn't jitter on a re-render. The Celebrations switch leaves them on. A fresh install is nothing but empty views, so this is the first thing a new user sees of Eigen's character.

### More triggers

Each follows the rules: your own action, in your tab.

- **Setup is done.** The first sign-in of the admin who ran `./eigen setup` shows a figure cutting a ribbon. Once ever, and always, since it can only happen once: a `UserSettings` flag remembers it, through the existing settings route.
- **The last open comment is resolved.** Resolving a thread that leaves the document with no open threads: a figure dusting off their hands. One in three.
- **The board is done.** A sticky moved into the last column that leaves the other columns empty. One in three.

### The setting

`UserSettings` (`packages/lib/src/types/settings.ts`) gets `celebrations?: boolean`, where missing means on. The `PUT /space/:ownerId/settings` body schema in `apps/api/src/routes/space.ts` gains the field, and the hook reads it through `useSpaceSettings`. A **Celebrations** switch under **Preferences** on Space's Personal info page reads "A small surprise now and then when you finish something". Existing route, existing `settings.json`, no migration.

It is on by default. A delight that's off by default is never found.

## Later

- **Docs word goal.** The word-count dialog (`apps/docs/src/components/docs/word-count-dialog.tsx`) gets an optional goal, and the toolbar shows a thin progress ring. Crossing the goal always celebrates.
- **Scripts.** The scripting platform's result actions ([PROPOSAL_SCRIPTING_PLATFORM.md](PROPOSAL_SCRIPTING_PLATFORM.md#scripts-app-and-editor-integration)) get a `celebrate` action with no parameters beyond a closed list of effects. A triggered run has no tab, so its celebration travels as a notification and the open tab shows it. This is how "celebrate when this person answers my mail" would work, once event triggers exist.

## Phases

| | Phase | Delivers | Size |
|---|---|---|---|
| **1** | `useCelebrate`, the burst, the setting, the sticky checklist trigger (built) | Confetti on a finished checklist | S |
| **2** | Stick figures in the empty states | Needs clipart Phase 2 and the four calm poses | S |
| **3** | Stick figure celebrations and the three triggers under More triggers | Needs Phase 2's figures | S–M |
| **4** | Docs word goal | Goal, progress ring, celebration | S–M |

After Phase 1, use it for two weeks before building more. If it still makes you smile, go on. If it annoys you, delete it.

## Open questions

1. Is one in three right? Too rare and nobody finds it; too often and it becomes noise. Easy to tune.
2. Should the very first completion on a device always celebrate, so people learn it exists? That needs a `localStorage` flag. Phase 1 has none.
3. Checkboxes can probably also be ticked in the card's edit form (`editForm`, a TipTap editor). That path needs a before-and-after count instead of the click handler. Check whether it's common enough to bother. Phase 1 celebrates only the click.
