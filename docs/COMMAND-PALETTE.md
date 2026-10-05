# Command Palette

> **TLDR:** The command palette is the ⌘K dialog every signed-in Eigen app shares: one text box to jump to an app, create a document, act on what is selected, or find a file, a mail, a contact, a help article or a match in the open document. It stores nothing. Each keystroke runs a set of sources over the typed text, and one pure function merges their results into fixed sections. The engine, parsers, sources and commands live in `packages/lib/src/core/command-palette/`, the dialog and its rows in `packages/ui/src/components/layout/app/command-palette/`.

A source is one kind of result and the code that produces it: the command catalog, contacts, smart suggestions, files, mail, help, the open document's matches and its comment threads. Some answer at once from data the browser already holds, such as the catalog and the contact list. Others are async: files and mail go to the search route ([SEARCH.md](SEARCH.md)), help to the help center's static Pagefind index ([HELP-CENTER.md](HELP-CENTER.md#the-landing-and-the-palette-share-one-loader)), and comment threads to their own server index. The palette has no backend of its own, so it grows whenever a source does: a file type the search index learns to read shows up in the palette with no palette change.

A result is a row with a `run` function, and running it gets a `CommandContext`: the signed-in owner, whether the server has mail, the current selection and the few helpers commands need (navigate, open a create dialog, open mail compose, open a preview, toggle the theme). The context is built in `PaletteRunner` (`packages/ui/src/components/layout/app/app-shell.tsx`), so a command never imports app code. The selection is not something the palette finds out for itself. A route publishes it: Drive publishes the rows a user selected, and an open document publishes itself.

The sections cover how a query is narrowed and merged, how the Top Hit is chosen, how routes publish their selection and why that publishing needs care, and where the catalog comes from. Three things in them surprise people:

- A document match never becomes the Top Hit, even when it is the best text match ([§ The Top Hit](#the-top-hit-is-a-sure-parse-or-a-strong-title-match-never-a-guess)).
- A slow source keeps its last results on screen while its next query runs, so sections never flicker or collapse ([§ The merge](#the-merge-is-a-pure-function-over-settled-sources)).
- A publishing hook that skips its own stabilising loops React into its update limit ([§ Publishing hooks](#a-publishing-hook-stabilises-what-it-publishes-or-the-palette-loops)).

## The merge is a pure function over settled sources

`buildSections` (`engine.ts`) takes every source's results and returns the Top Hit plus the sections in a fixed order: Suggestions, Selection, In Document, In Comments, Files, Mail, Contacts, Help, Actions. Each section is sorted by its own source's rank and capped at six rows. The catalog sits last because a typed command name finds it anyway, while search hits and selection actions are what the palette is usually opened for.

`useCommandResults` holds each async source at its last results until that source's own query settles (`useStableWhilePending`). So the merge never sees a half-finished state, the instant sources still update on every keystroke, and a slow one, such as Pagefind loading its WASM index the first time, cannot freeze the others. Every async source debounces the input by 150 ms first. The merge is pinned by `packages/lib/src/test/core/command-palette/engine.test.ts`.

With an empty box the palette shows the Selection section when a route published one, and otherwise a short Suggested list of catalog commands (`SUGGESTED_COMMAND_IDS`). Nothing is searched until there is text.

## A prefix or the Tab chip narrows the palette to one source

A scope limits the palette to one kind of result. `parseQuery` reads it from a typed prefix: `mail:`, `file:`, `doc:`, `>` for actions, `@` for contacts and `?` for help. Tab sets the same scope as a chip and steps through In document, Files, Mail, Actions, Contacts and Help, and Backspace at the start of the box clears it. A typed prefix wins over the chip, because it is the latest thing the user said. The same parser lifts `from:` and `to:` operators out of the text for the mail search.

A scope does more than hide sections. Each async source checks it and skips its request when the scope excludes it, so `@` never queries the search route and help never loads its index while the user narrowed to mail. Selection actions stay visible under every scope, because acting on the current item is still possible while the list is narrowed.

The Tab stop for In document exists only while a document is open, so Tab never lands on an empty scope. The `doc:` prefix still works with nothing open, and the empty state then says to open a document rather than showing a bare "No results". Comment-thread hits appear under `doc:` only and never in the unscoped list ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#comment-threads-are-searched-on-the-server)).

## The Top Hit is a sure parse or a strong title match, never a guess

The Top Hit is the row Enter runs. In the unscoped palette a deterministic smart result claims it outright: the whole input is an email address (Mail to, or Send the selected files to, when a selection is published) or an `http`/`https` URL (Open link). Only those two shapes count, because a wrong confident suggestion costs more trust than a right one earns, and only those two protocols, so a `javascript:` or `data:` URL never becomes a link (`parse-smart-input.ts`).

Without such a parse, the strongest structural title match wins across selection actions, files, mail, contacts, help and the catalog: an exact title beats a title that starts with the query, which beats a title that holds every word (`rank.ts`). Anything weaker gets no Top Hit. Document matches are left out on purpose: their title is the matched text itself, so they would take Enter from a typed file name. The promoted row is removed from its own section, and a section it leaves empty disappears.

The top contact match also yields non-deterministic smart rows under Suggestions, such as "Send mail to" its address. They never claim the Top Hit, so the contact card itself can.

## A catalog command shows only when its title or keywords match

A catalog command has a `baseRank` that orders it within its section and a match boost from the typed text (`actionBoosts`): a title prefix, a title substring or a keyword. A command is listed only when its boost is above zero. Every catalog command has a positive `baseRank`, so filtering on the total score would list every command for any query. The rank tiers and their reasons are in `commands/base-ranks.ts`.

Selection commands carry `group: 'selection'` and a `dynamicTitle` that names the item ("Share Q4 budget"), and their `availability` hides any that cannot apply. A selection flagged `isCurrentDocument` hides Open, Open in new tab and Quick preview, because the user is already inside that file. `packages/lib/src/test/core/command-palette/commands/drive.test.ts` pins the availability of Quick preview, Download and the Mail commands.

## The catalog is derived from the shared registries

The Go to commands map the shared `apps` registry, and the New commands map `EIGEN_DOC_TYPE_INFO` and `EIGEN_DOC_ICONS`, so a new app or document type appears in the palette with the same label and icon as in the app switcher and Drive's New menu, with no palette change. New opens the same create dialogs Drive's New menu uses, mounted beside the palette in `PaletteRunner`.

On a server without hosted mail, the rows that lead into Mail are gone: Go to Mail, the Mail selection command, the mail source and the mail suggestions all check `ctx.mailEnabled`, so no row leads into an app that is not there.

## A route publishes its selection and the actions it can run

The palette learns what is selected through three publishing hooks. `usePaletteSelection` publishes Drive's selected rows (`drive-list.tsx`). `usePaletteDocSelection` publishes an open document as a one-item selection flagged `isCurrentDocument`, through `useEigenDocEditorRoute`. `usePaletteDocSearch` publishes the open document's find controller and comment search, through `DocSearchProvider` ([IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md#the-palette-reads-the-same-controller)). Unmounting a publisher clears what it published, and the last one to publish wins.

Commands that need only a URL or the clipboard, such as Copy link, Open in new tab and Mail to, run straight from the catalog. Commands that open a dialog the route owns, such as Rename, Share, Download, Email collaborators and Move to trash, call handlers the route publishes with `usePaletteSelectionActions`. Drive publishes its dialog openers (`drive-layout-dialogs.tsx`), and every document's File menu publishes Share, plus Rename, Email collaborators and Move to trash for a writer (`file-menu.tsx`). A command whose handler nobody published stays hidden, so the palette never offers an action the page can't perform.

## A publishing hook stabilises what it publishes, or the palette loops

Publishing writes into the palette's context, and every consumer of that context re-renders, the publisher included. If the published value had a new identity on each render, the publish effect would run again, update the context again, and trip React's maximum update depth. Callers can't reliably prevent that, since one handler built from an unstable prop is enough.

So each publishing hook stabilises the value itself. The handlers route through a ref to the latest implementation, and the published identity changes only when its shape does: the set of item ids for a selection, which handlers are present for the actions, whether a controller exists for document search, and the document's key for comment search. A new publisher reuses these hooks rather than calling the context setters.

## The palette is signed-in only and opens on Mod+K from anywhere

`CommandPaletteProvider` is part of the `EigenApp` provider stack and `PaletteRunner` renders in `AppShell` ([LAYOUT.md](LAYOUT.md#every-app-is-eigenapp-around-appshell)). The index app's blog and help pages use `AppShell` without that stack, so shared code reaches the palette through `useOptionalCommandPalette` and renders nothing without it. `PaletteRunner` also renders nothing for a signed-out visitor, so the shortcut never binds there.

Mod+K is captured on `window`, inside other inputs too, and toggles the dialog (`use-palette-shortcuts.ts`). The palette is the only Mod+K consumer. The topbar shows a search pill on wider screens and a search icon on phones.

Running a row runs its command and closes the dialog. A jump to another app is a full page load (`window.location.href`), because every app is its own single-page app under its own path. The input and scope reset when the dialog opens, not when it closes, so a row that navigates keeps its query on screen until the page changes instead of flashing the Suggested list during the close animation.

## See also

- [SEARCH.md](SEARCH.md): the search route behind the file and mail sources
- [IN_DOCUMENT_SEARCH.md](IN_DOCUMENT_SEARCH.md): the find controller behind the `doc:` scope
- [HELP-CENTER.md](HELP-CENTER.md): the Pagefind index behind the help source
- [LAYOUT.md](LAYOUT.md): the app shell the palette mounts in
- [PROPOSAL_COMMAND_PALETTE.md](proposals/PROPOSAL_COMMAND_PALETTE.md): what is left to build
