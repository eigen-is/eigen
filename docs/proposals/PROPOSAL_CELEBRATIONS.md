# Proposal: Celebrations

This proposal adds a small surprise when you finish something in Eigen: a burst of confetti or a cheering stick figure when you tick the last box of a sticky's checklist.

**Status:** not started. Nothing here is built.

> **TLDR**: One shared `useCelebrate()` hook in `packages/ui` draws a short burst from the point where you finished something, then removes itself. The first trigger is the last checkbox of a sticky's task list, in `NoteCardDialog`. It fires only for your own click, only now and then, and never for a teammate's edit. Later celebrations can show a stick figure from the clipart catalog ([PROPOSAL_CLIPART.md](PROPOSAL_CLIPART.md)) instead of confetti. One personal setting turns it all off. No package, no new route, no migration.

## Why

A sticky card already shows a progress bar and a `3/5` count for its task list (`NoteCard`, `packages/ui/src/components/notes/note-card.tsx`). You watch it fill up, and then nothing happens when it's full. A small reward at that moment makes Eigen feel a bit warmer than an admin tool, and it costs an afternoon.

The apps that do this well (Asana's flying unicorn, Apple's activity rings, Things' checkbox) share a few habits. The reward lands on the click that earned it. It is rare enough to stay a surprise. And it is easy to switch off. The ones that go wrong (Duolingo's streak guilt) turn it into points and pressure. This proposal copies the first group and avoids the second.

## Non-goals

- Points, streaks, badges, levels or leaderboards. Celebrations are private and never compare people.
- Sound.
- An admin or team setting. If a customer asks to turn it off for a whole organization, that is a one-line addition then.
- Celebrations for something another person did.

## The rules

1. **Only your own action.** A celebration fires from the click that completed something, in your tab. An edit that arrives from a teammate, a page load or a refetch never fires one.
2. **Only now and then.** Something that just happens to be complete, like a checklist, celebrates with a chance of one in three. A goal you set yourself (the word goal under Later) always celebrates, because you asked for it.
3. **Once per completion.** The chance is rolled once per dialog opening. Unticking and re-ticking the last box in the same dialog does nothing, so it can't be farmed.
4. **Reduced motion is respected.** With `prefers-reduced-motion: reduce`, there is no burst and no hop. The card's progress bar gives a short glow instead.
5. **One switch.** The personal setting below turns everything off.

## Design

### The burst

`useCelebrate()` in `packages/ui/src/components/celebrate/` returns `celebrate(origin: DOMRect)`. The hook reads the setting and `prefers-reduced-motion`, and applies the chance, so a call site is one line and never checks anything itself.

A burst is a fixed, full-viewport `<canvas>` with `pointer-events: none`, appended to `document.body`. About 80 particles spray up from the top of `origin` and fall under gravity for about 1.5 seconds. Then the canvas removes itself. A second burst while one is running is dropped. It is about 60 lines of our own code. `canvas-confetti` would do the same, but a new package needs its own approval, and this is small enough to write.

### The first trigger: a sticky's checklist

`NoteCardDialog` (`packages/ui/src/components/notes/note-card-dialog.tsx`) toggles a task-list checkbox in `handleDescriptionClick` and passes the new HTML to `onDescriptionChange`. That is where it fires: if the click checked a box, and the list now has at least two items and all of them are checked, call `celebrate(input.getBoundingClientRect())`. The confetti comes out of the box you just ticked.

`NoteCard` counts checked and total items with two regexes. The dialog needs the same count, so the counting moves into one exported helper that both use. `NoteCardDialog` also serves `CardDialog` (`packages/ui/src/components/cards/card-dialog.tsx`), so cards outside the Stickies app get the same behavior.

A checklist with one item is a toggle, not a list, so it doesn't count.

### Stick people from the clipart catalog

Once the clipart catalog exists, a celebration can be a stick figure instead of confetti: one of the catalog's celebrating poses (cheering, jumping, holding a trophy). It is drawn with `renderClipartSvg` at roughness 1 and a fresh random seed, so the hand-drawn jitter is different every time. It pops up next to `origin`, hops once and fades out after about two seconds. The whole SVG moves with a CSS transform; the limbs don't animate.

When a celebration fires, it is usually confetti. About one in four is a stick figure. This waits on Phase 2 of [PROPOSAL_CLIPART.md](PROPOSAL_CLIPART.md), which adds `layoutClipart` and the stick-people category.

### The setting

`UserSettings` (`packages/lib/src/types/settings.ts`) gets `celebrations?: boolean`, where missing means on. The `PUT /space/:ownerId/settings` body schema in `apps/api/src/routes/space.ts` gains the field, and the hook reads it through `useSpaceSettings`. A switch in the Space app's preferences reads "Celebrations: a small surprise now and then when you finish something". Existing route, existing `settings.json`, no migration.

It is on by default. A delight that's off by default is never found.

## Later

- **Docs word goal.** The word-count dialog (`apps/docs/src/components/docs/word-count-dialog.tsx`) gets an optional goal, and the toolbar shows a thin progress ring. Crossing the goal always celebrates.
- **Inbox zero in Mail.** A calm version: a stick figure on an empty desk, not a party.
- **Scripts.** The scripting platform's result actions ([PROPOSAL_SCRIPTING_PLATFORM.md](PROPOSAL_SCRIPTING_PLATFORM.md#scripts-app-and-editor-integration)) get a `celebrate` action with no parameters beyond a closed list of effects. A triggered run has no tab, so its celebration travels as a notification and the open tab shows it. This is how "celebrate when this person answers my mail" would work, once event triggers exist.

## Phases

| | Phase | Delivers | Size |
|---|---|---|---|
| **1** | `useCelebrate`, the burst, the setting, the sticky checklist trigger | Confetti on a finished checklist | S |
| **2** | Stick figure celebrations | Needs clipart Phase 2 | S |
| **3** | Docs word goal | Goal, progress ring, celebration | S–M |

After Phase 1, use it for two weeks before building more. If it still makes you smile, go on. If it annoys you, delete it.

## Open questions

1. Is one in three right? Too rare and nobody finds it; too often and it becomes noise. Easy to tune.
2. Should the very first completion on a device always celebrate, so people learn it exists? That needs a `localStorage` flag.
3. Checkboxes can probably also be ticked in the card's edit form (`editForm`, a TipTap editor). That path needs a before-and-after count instead of the click handler. Check whether it's common enough to bother.
