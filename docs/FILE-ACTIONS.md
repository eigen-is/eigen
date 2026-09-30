# Quick Look and File Actions

> **TLDR:** Every surface that shows a file (a Drive listing, the mail reader, a chat or card attachment) acts on it through one `FileSubject`, one registry of what can be done with it (`FILE_ACTIONS`) and one runner that performs a row. The quick-look overlay is one more host of the same rows. Types and builders live in `packages/lib/src/types/file-subject.ts` and `packages/lib/src/core/`, the UI in `packages/ui/src/components/file-actions/` and `drive/file-preview.tsx`. Not obvious: a subject stores identity only, a registry row never asks which surface draws it, and the host mounts the runner's dialogs because a menu unmounts on close.

## A subject stores identity, everything else is derived

A `FileSubject` is a `DrivePath` or a mail part reference (`{ ownerId, messageId, index }` plus the part's name, type and size). It holds nothing that follows from that identity. `subjectInfo(subject)` derives the rest in one place: the key siblings are matched on, the name, the mime, the size, and the embed, download and thumbnail URLs. So no surface composes a route by hand, and no fact is stored twice where it could disagree.

`subjectFromPath` and `subjectFromMailAttachment` in `packages/lib/src/core/file-subject.ts` are the only builders. A mail subject carries the **raw** part index the mail routes address, calendar parts included, so a reader that hides those parts still names the right one. `importSourceOf` answers where an import reads the bytes: a Drive file is copied server-side, anything else is fetched from its download URL.

Two flags come from the surface that holds the file:

- `readOnly`: the viewer can't write where the file sits, such as a watched feed. The convert rows write the new document beside the source, so they drop out. The surface sets it from its own `DriveCapabilities.canWrite` ([LAYOUT.md](LAYOUT.md)).
- `attachment`: the file belongs to a message or a container, not to a Drive location. Its siblings are a set, which is what draws the overlay's "Save all (n)". And a chat or card attachment's Drive copy sits in a hidden media folder, so a convert saves to a folder the user picks first.

## A registry row never asks which surface draws it

`FILE_ACTIONS` (`packages/lib/src/core/file-actions.ts`) lists what can be done with a file: Quick preview, Download, Save to Drive, the two converts and the three imports. Each row's `applies` reads the derived facts, and for a few rows the identity behind them. `fileActionsFor(subject, exclude?)` derives the facts once for the whole list. A new row shows up in every menu and in the overlay footer without editing one.

Save to Drive declines a Drive file that isn't an attachment, because Drive's own "Copy to…" does that. An import row declines a file over its import ceiling, because the route would answer 413.

`useFileActions` (`packages/ui/src/components/file-actions/use-file-actions.ts`) is the one place that knows who is asking. An import route refuses a guest while `applies` is handed only the file, so rows flagged `guestDenied` drop out for a guest there. Rows flagged `mailOnly` drop out on a server without hosted mail.

## The host mounts the runner's dialogs

`useFileActionRunner(subject, siblings?, exclude?)` performs a row. `FileActionMenuItems` draws the rows as menu items and takes the runner rather than building one. A menu's content unmounts when it closes, so the picker a row opens must live above it: the host renders `runner.dialogs` once. The rows come from `runner.subject`, so a host can't pair one menu with another's subject.

The subject may be `null` for a host whose subject is state, like the right-clicked chip. What a picker acts on is snapshotted when the row runs, because the menu that drew the row is closed by the time the picker is confirmed.

A convert on an attachment opens the Save to Drive picker first, titled with the row's label and confirmed with **Save and convert**. `useConvertDocument` then runs on each file the save created. Import to Calendar opens a target picker before it imports ([CALENDAR.md](CALENDAR.md)). The overlay disables its footer while `runner.isPending`, and its focus trap stands down while `runner.isDialogOpen`.

## Save to Drive copies on the server

`SaveToDrivePicker` (`packages/ui/src/components/drive/save-to-drive-picker.tsx`) is the one "where does this go" dialog. A Drive subject is copied server-side, so its bytes never travel through the browser. A mail subject is written from the message the server still holds, in one call for every part. "Download instead" falls back to browser downloads, staggered because a browser drops the later downloads of a burst fired in one tick.

Siblings come from one surface, so a batch is all Drive items or all mail parts, and the first subject picks the branch. The picker renders above the overlay through `DialogContent`'s `abovePreview` prop.

## The overlay picks its mode from the subject

`PreviewProvider` stores the subject and its siblings and portals `FilePreview` to `<body>`. `openPreview(subject, siblings?)` takes the siblings the arrow keys page through. A Drive listing passes its folder without the `attachment` flag, so the overlay never offers to copy a folder onto itself.

`getPreviewMode(subject)` decides on the client, with the same text gate the routes run ([PREVIEWS.md](PREVIEWS.md)). An image needs a mount to be resized, so only a Drive image uses `/preview`. A mail image shows its original bytes, which makes it an image only for a mime in `BROWSER_IMAGE_MIMES`. A HEIC part gets the file card rather than a broken box.

`ProgressiveImage` stacks the 512 px thumbnail under the screen preview so the image shows at once. The box takes its ratio from the Drive row. A mail part has no stored size, so the box measures the image once it loads and then hugs it, and a click beside it reaches the backdrop that closes the overlay. The component is keyed on the preview URL, so a sibling never inherits the previous image's size.

## The overlay's keys stand down for a layer above it

Escape closes, the arrows page, and Space closes the way it opened, like Finder's Quick Look. The keys listen on the document, so they must yield to a layer open above the overlay.

Every layer portals to `<body>` in the order it opened, so later in the document is higher in the stack. `useDialogOpen(overlayRef)` (`packages/ui/src/hooks/use-dialog-open.ts`) asks whether a `role="dialog"` after the overlay is open. A stickies card dialog the overlay was opened from sits before it, so it doesn't count.

Presence is not enough for the keydown in hand. A layer dismisses itself on the capture phase of the same keydown the overlay hears on the bubble, so by then the layer is gone. So a keydown whose target sits inside a dialog, menu or listbox after the overlay belongs to that layer. A `DialogContent` under an open preview ignores Escape, which is the overlay's to close.

Space yields when focus is on a control inside the overlay, where it presses that control. The overlay registers it with `preventDefault: false`, because the hotkey library prevents the default before the callback runs.

## One hook wires every attachment chip to the menu

`useAttachmentChipMenu` (`packages/ui/src/components/attachment/use-attachment-chip-menu.ts`) connects the chips in the mail reader, chat and the card dialog to the singleton context menu. It handles right-click and touch long-press, and reads the chip under the pointer at pointer-down, because a long-press reports only where it started. A right-click on a plain link or a text selection is left to the browser's own menu. The host draws the menu's content: `FileActionMenuItems`, plus its own rows in chat ([CHAT.md](CHAT.md)).

## See also

- [PREVIEWS.md](PREVIEWS.md): what the overlay's panels render
- [PREVIEW-PAYLOADS.md](PREVIEW-PAYLOADS.md): the `.vcf`, `.eml` and `.ics` panels
- [LAYOUT.md](LAYOUT.md): Drive's item menu, capabilities and the overlay's z-index
