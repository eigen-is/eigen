# Command Palette

> **TLDR:** The command palette is the ⌘K dialog every signed-in Eigen app shares: one text box to jump to an app, create a document, act on what is selected, or find a file, a mail, a contact, a help article or a match in the open document. It stores nothing and has no backend of its own. The engine lives in `packages/lib/src/core/command-palette/`, the dialog in `packages/ui/src/components/layout/app/command-palette/`.

Each keystroke runs a set of sources over the typed text. A source is one kind of result and the code that produces it: the command catalog, contacts, smart suggestions, files, mail, help, the open document's matches and its comment threads. The catalog and contacts answer at once from data the browser holds. The others are async: files and mail go to the search route ([SEARCH.md](SEARCH.md)), help to the help center's Pagefind index ([HELP-CENTER.md](HELP-CENTER.md#the-landing-and-the-palette-share-one-loader)), comment threads to their own server index. So the palette grows whenever a source does: a file type the search index learns to read shows up with no palette change.

A result is a row with a `run` function. Running it gets a `CommandContext` built in `PaletteRunner` (`app-shell.tsx`): the signed-in owner, whether the server has mail, the selection and a few helpers (navigate, open a create dialog, compose mail, preview). So a command never imports app code. The palette never finds the selection itself: a page publishes it, with the rows it can run on it.

Three things surprise people: a document match never becomes the Top hit, a slow source keeps its last results on screen, and a publishing hook that doesn't stabilise its value loops React.

## The merge is a pure function over settled sources

`buildSections` (`engine.ts`) takes every source's results and returns the Top hit plus the sections in a fixed order: Suggestions, Selection, In document, In comments, Files, Mail, Contacts, Help, Actions. Each section is sorted by its source's rank and capped. The catalog sits last because a typed command name finds it anyway, while search hits and selection actions are what the palette is usually opened for.

`useCommandResults` holds each async source at its last results until its own query settles (`useStableWhilePending`). So the merge never sees a half-finished state, sections never flicker, and a slow source, such as Pagefind loading its index the first time, can't freeze the others. `packages/lib/src/test/core/command-palette/engine.test.ts` pins the merge.

With an empty box the palette shows the published selection, or else a short Suggested list (`SUGGESTED_COMMAND_IDS`). Nothing is searched until there is text.

## A prefix or the Tab chip narrows the palette to one source

`parseQuery` reads a scope from a typed prefix: `mail:`, `file:`, `doc:`, `>` for actions, `@` for contacts, `?` for help. Tab sets the same scope as a chip and Backspace at the start of the box clears it. A typed prefix wins over the chip, because it is the latest thing the user said. The parser also lifts `from:` and `to:` out of the text for the mail search.

A scope skips work, not just sections: each async source checks it and sends no request when excluded, so `@` never queries the search route. Selection actions stay visible under every scope, since acting on the current item is still possible while the list is narrowed. Tab stops on In document only while a document is open, and comment-thread hits appear under `doc:` only ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#comment-threads-are-searched-on-the-server)).

## The Top hit is a sure parse or a strong title match, never a guess

The Top hit is the row Enter runs. In the unscoped palette a sure parse claims it: the whole input is an email address (Mail to, or Send the selection to when the page published a Mail to row) or an `http` or `https` URL (Open link). Only those two shapes count, because a wrong confident suggestion costs more trust than a right one earns, and only those protocols, so a `javascript:` URL never becomes a link (`parse-smart-input.ts`).

Otherwise the strongest title match wins across selection actions, files, mail, contacts, help and the catalog: an exact title, then a title prefix, then a title that holds every word (`rank.ts`). Anything weaker gets no Top hit. Document matches are left out: their title is the matched text itself, so they would take Enter from a typed file name. The promoted row leaves its own section.

The top contact also yields smart rows under Suggestions, such as "Send mail to" its address. They never claim the Top hit, so the contact card itself can.

## A catalog command shows only when its title or keywords match

A catalog command has a `baseRank` that orders it within its section, plus a boost from the typed text for a title prefix, a title substring or a keyword (`actionBoosts`). It is listed only when the boost is above zero: every `baseRank` is positive, so filtering on the total would list every command for any query. The tiers and their reasons are in `commands/base-ranks.ts`.

## The catalog is derived from the shared registries

The Go to commands map the shared `apps` registry, and the New commands map `EIGEN_DOC_TYPE_INFO` and `EIGEN_DOC_ICONS`, so a new app or document type appears with the same label and icon as in the app switcher and Drive's New menu. New opens the same create dialogs Drive uses. On a server without hosted mail, every row that leads into Mail checks `ctx.mailEnabled` and is gone.

## A route publishes its selection and the actions it can run

`usePaletteSelection(items, actions)` publishes the selected items and the menu rows bound to them, each with its `run`. `usePaletteDocSearch` publishes the open document's find controller and comment search ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#the-palette-reads-the-same-controller)). Unmounting a publisher clears what it published, and the last one to publish wins.

A Drive listing publishes through `DrivePaletteSelection`, the same rows in the same order as the item's menu; Trash publishes only its own Restore and Delete permanently. An open document's File menu publishes the document with the Drive rows it can run, gated with `browseCapabilities(canWrite)` as Drive gates them, so a reader gets only Download as, Copy link and Mail to. The palette offers only rows a page published, so it never offers an action the page can't perform.

`selectionCommands` (`commands/selection.ts`) turns each published row into a command with the menu's own label (plural for a multi-selection) and the item's name as subtitle. One derivation serves every row, so the palette offers exactly what the menu offers in the same words. Download as becomes one command per format, listed after every other row so the formats never push the rest out of the section. `selection.test.ts` pins the titles, the order and the formats.

## A publishing hook stabilises what it publishes, or the palette loops

Publishing writes into the palette's context, and every consumer re-renders, the publisher included. If the published value had a new identity each render, the effect would publish again and trip React's maximum update depth, and a caller can't reliably prevent that.

So each publishing hook stabilises the value itself. Every `run` routes through a ref to the latest implementation, and the published identity changes only when its meaning does: the items' ids and names and the rows' ids and labels, whether a find controller exists, the document's key for comment search. A new publisher reuses these hooks rather than calling the context setters.

## The palette is signed-in only and opens on Mod+K from anywhere

`CommandPaletteProvider` is part of the `EigenApp` provider stack and `PaletteRunner` renders in `AppShell` ([LAYOUT.md](LAYOUT.md#every-app-is-eigenapp-around-appshell)). The index app's blog and help pages use `AppShell` without that stack, so shared code reaches the palette through `useOptionalCommandPalette`. `PaletteRunner` renders nothing for a signed-out visitor, so the shortcut never binds there.

Mod+K is captured on `window`, inside other inputs too, and toggles the dialog (`use-palette-shortcuts.ts`). Like every dialog, the palette gives the focus back on close ([LAYOUT.md § A closing dialog gives the focus back](LAYOUT.md#a-closing-dialog-gives-the-focus-back)), so a Drive listing's keys work without a click. A jump to another app is a full page load, because every app is its own single-page app. The input resets when the dialog opens, not when it closes, so a row that navigates keeps its query on screen until the page changes.

## See also

- [SEARCH.md](SEARCH.md): the search route behind the file and mail sources
- [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md): the find controller behind the `doc:` scope
- [HELP-CENTER.md](HELP-CENTER.md): the Pagefind index behind the help source
- [LAYOUT.md](LAYOUT.md): the app shell the palette mounts in
- [PROPOSAL_COMMAND_PALETTE.md](proposals/PROPOSAL_COMMAND_PALETTE.md): what is left to build
