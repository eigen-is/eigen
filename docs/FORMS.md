# Forms

> **TLDR:** A form is any place where a user types or picks something Eigen then stores, and every form that holds a typed draft sits on one of three shells: a dialog, a card or a page. The shell owns the rules every form shares (its keys, what happens on a close with changes, the first focus, where an error shows, the pending button), so a form gets them by using its shell and a fix to a shell reaches every form of its kind. The shells live in `packages/ui/src/components/`, on one base, `FormShell`.

A form is New event, Rename, a card's edit, Personal info, Admin's Server settings or a cell's number format. The truth is always the stored thing, on the server or in the document; a form only holds a draft of it until it commits. A typed draft waits for a button, so a half-typed name never reaches anyone. A single pick writes at once, because a Save button for one click is noise.

The rules follow Google Workspace where Google has a counterpart ([CODE-STANDARDS.md § Dates and labels](CODE-STANDARDS.md#dates-and-labels)). How a dialog looks (its two widths, its one footer, the confirm dialog, focus return) is [LAYOUT.md § A dialog is wide unless it is small and has nothing to type in](LAYOUT.md#a-dialog-is-wide-unless-it-is-small-and-has-nothing-to-type-in) and the sections after it; who raises a toast is [NOTIFICATIONS.md](NOTIFICATIONS.md). FORMS.md owns how a form behaves.

Four words recur. A form is **changed** when its fields differ from what it opened with; the shells ask before a close drops a changed form. A **refused** submit is one the form's own check stopped, such as an empty title, so the form stays and points at the field. **Pending** is the state of a submit that runs, during which the form waits. A **probe** is one rule that `expectFormContract`, the shared test, checks on a rendered form.

What surprises people: in a dialog Esc asks before it drops a change, but Cancel doesn't, outside Drive's text editor ([§ Discard](#a-changed-form-asks-discard-changes-before-it-closes)); Save is never disabled to say a field is wrong ([§ Errors](#a-problem-shows-as-red-text-under-its-field)); Esc in a card's edit goes back to the card, not out of it; and Back with a changed dialog open over a clean page leaves without asking ([§ Leave guard](#a-page-form-with-unsaved-edits-asks-before-you-leave)).

## Every form is one of eight kinds, and four have a shell

| Kind | Shell | Examples | What the shell owns |
|---|---|---|---|
| Dialog form | `FormDialog` + `FormDialogForm`; the Drive pickers on `DriveLocationPicker` and `DriveFilePicker` | New event, Rename, Create user, every Docs and Sheets format dialog, Move, Copy, Import | Footer, Enter and Cmd+Enter, "Discard changes?", focus, the error focus, pending |
| Card | `CardForm` in `CardFormDialog`, or in `CardDialogFrame` for an existing card | Add card, a card's edit, Add comment in the editors | The same, plus edit in place: Esc and Cancel go back to the card's view |
| Page form | `PageForm` with `submitLabel` and an optional `onCancel` | Team settings, Personal info, Create contact | The same as a dialog, plus the leave guard; Cancel and Save throughout |
| Draft page | `PageForm` with `onReset` | Admin's Server settings, Onboarding, Guest access | A Reset and Save footer that shows once something changed, plus the leave guard |
| Autosave control | none: the control calls its hook | Space preferences, calendar visibility, Theme, Assign label | Nothing to own: the control writes on each pick, and its new state is the feedback |
| Side panel | the rows in `properties-panel/` | The image, text box, chart and canvas panels | Writes straight into the document; undo is the way back |
| Inline field | none: each field | Sheet tab rename, formula bar, font size box | Enter or blur commits, Esc puts the old value back |
| Composer | `ChatMessageInput`, `EmailDraft` | Chat and card threads, Mail | Their own send keys and drafts ([§ Composers](#a-composer-sends-and-keeps-its-own-draft)) |

`FormDialog`, `CardForm` and `PageForm` are drawn on `FormShell` (`packages/ui/src/components/form-shell.tsx`), the `<form>` that carries the keys and the error focus once, so a dialog, a card and a page can't drift apart on them. The Drive pickers render `FormShell` themselves, since their body is a folder browser rather than a list of fields, and share the dialog's footer, `FormFooter`. A form that is none of the kinds, such as the sign-in page or first-run setup, uses `FormShell` directly, and so does a section with its own Save inside a larger page, such as Space's Mail signature, with a `LeaveGuard` beside it. `FormShell` is no barrel export: apps reach it by its sub-path, mostly for `useFormSubmitted`. A form that needs something no shell offers gets it in its shell, not beside it.

## A typed field waits for Save, a single control saves at once

Text a user types waits for the form's button. A switch, a select, a colour or a panel control that stands alone writes on each pick. One section never mixes the two: a switch inside a form with a Save button is part of the draft and waits too, and a control that writes at once sits outside any form with a button. One look tells the user whether a section saves itself. The one select that waits is the role in Admin's user detail, with its own Save and Cancel: a role grants or takes away admin rights, so a slip in the select must not do that.

Space's Mail page shows both, as two sections with their own headings: the signature waits for its Save, the keyboard switches below it save themselves. An action inside a draft page that acts at once, such as Send test mail in Server settings, is a button that says what it does, never a field, and Enter on it does that action. Slides' background panel paints the current slide live, and its Apply button sends that paint to the slides its "Apply to" select names, so a colour drag never repaints the whole deck.

## Enter submits, and Cmd or Ctrl+Enter submits from any field

Enter in a one-line field submits the form, as the browser does. On a draft page with nothing changed it does nothing. `FormShell` adds two keys the browser lacks. Cmd+Enter (Ctrl+Enter off a Mac) submits from any field, a multi-line one included. Enter on a radio or a checkbox submits too, because Radix swallows it there and a dialog whose first control is a radio, such as the calendar's "This event / following / all", would otherwise not answer Enter at all.

`FormShell` acts only on a key whose target is inside its own form (`form.contains(event.target)`) and stops Cmd+Enter from going further, so a form needs no check for an open dialog: a dialog's own form is the one that gets the key. It submits one task after the key, so a field that commits on Enter, such as a time field, has set its value first. A document-wide hotkey is different: it fires wherever the focus is, so Mail's Cmd+Enter send stands down while a dialog is open ([LAYOUT.md § Document keymaps stand down while a dialog is open](LAYOUT.md#document-keymaps-stand-down-while-a-dialog-is-open)) and a form dialog over a draft doesn't send it.

A rich-text field inside a form passes `submitOnModEnter` to `LightEditor`, which takes Cmd+Enter from its line-break shortcut so the form gets it, and Shift+Enter is the line break. A guest field's Enter adds the address and an open suggestion list picks its row. Email collaborators is the one form where plain Enter in a one-line field does not submit: a sent email can't be taken back, so its Subject waits for Cmd+Enter or Send. Outside the shells an editor keeps its own Cmd+Enter: a Docs page break, the equation panel's commit, Mail's and Chat's send.

A double Enter submits once. `useDialogPending` (`packages/ui/src/hooks/use-dialog-pending.ts`), the one submit lifecycle of every shell, ignores a second submit while one runs, and any submit once its dialog is closing, so an Enter while it fades out doesn't copy twice. A form that navigates after its save awaits the navigation in its submit, so its button stays pending through it, or a second Enter in the gap would create a second contact.

## A changed form asks "Discard changes?" before it closes

A form with nothing changed closes at once on Esc, an outside click or the corner X. A changed one asks first, because Esc and a stray click are easy to press by accident. Cancel asks nothing in a dialog, a card or a page: it is a button that says it discards, and a page's Cancel leaves with `ignoreBlocker`. The one exception is the Cancel of Drive's text and markdown editor (`use-editor-save.ts`), which asks "Discard changes?", because leaving edit mode there can drop a long text with one click. The question is one `ConfirmDialog` with one wording, `DISCARD_CHANGES_QUESTION`: "Discard changes?", "What you changed is not saved.", Keep editing and a red Discard. `useDiscardChanges` (`packages/ui/src/hooks/use-discard-changes.tsx`) takes the dialog's `open`, `changed` and `pending` and hands Radix its `onOpenChange`, so the shells route those three closes through it; while a save runs a close does nothing, since the save decides whether the form closes.

`FormDialogForm` and `PageForm` both require `changed`. A dialog form with a field passes what differs; one that is a single choice, such as the calendar's recurring choice, passes false, since it loses nothing by closing. A form on `useState` compares its state with what it loaded; a react-hook-form form passes `formState.isDirty`, read where the React Compiler can't cache it, as `useFollowedFields` does ([ARCHITECTURE.md § Pitfalls](ARCHITECTURE.md#pitfalls)). `CardForm` owns its fields in `useState`, so it computes `changed` itself and reports it up through `onChangedChange`. `DriveLocationPicker` counts only its name field, in New doc or New folder: a picked folder is not typed input, and leaving it loses nothing typed. A colour swatch, a staged share and an address typed but not yet added count like typed text.

A typed address is the one change a form can lose silently, since it is not in the list yet. A people field from `useContactInput` (`packages/ui/src/components/contacts/use-contact-input.ts`) says `hasText`, which its form ORs into `changed`, and the form's submit calls `commitTyped()` first. That returns `{ added }` with the person added, so the save includes them, or `{ refused }` with the reason the field shows, and the submit then returns false and the dialog stays. Every host refuses a person already in the list the same way, and a host refuses the user's own address.

A card in edit mode goes back to its view instead of closing. Esc with changes asks first and then does what Cancel does; the X and an outside click ask too, then close the card. A stacked dialog asks for itself only: a New folder opened from a picker asks about its name, and Esc on the question keeps editing.

## A page form with unsaved edits asks before you leave

`PageForm` renders `LeaveGuard` (`packages/ui/src/components/layout/app/leave-guard.tsx`) while its draft differs from what it loaded. A click on another page or the browser's Back meets the same "Discard changes?" a dialog asks, through the router's `useBlocker`; a reload or a closed tab gets the browser's own prompt through `beforeunload`, since a page can't word that one. The guard asks while a save runs too, since the save may fail and the draft would go with the page; the save's own navigation, such as Create contact opening the new contact, passes `ignoreBlocker`, as Cancel's does. A guard that goes inactive while it asks lets the waiting navigation proceed.

A dialog has no leave guard. It is modal, so the sidebar and the page behind it take no click, and its own close already asks. Back is not a click: Back with a changed dialog open over a clean page navigates without asking, and a reload drops the dialog's draft. That is accepted, since a dialog's draft is short and the user can open it again; a page's draft can be long.

Sign-in, the two-factor step and invite sign-up have no guard: nothing stored is lost by leaving them, and a password manager refills them. The Drive text editor and offline collab edits use the same guard, the latter with its own question ([COLLAB.md](COLLAB.md)). Mail's composer has its own blocker (`useBlocker` with `enableBeforeUnload`), which asks only before a tab unloads, since an in-app navigation runs its closing save ([MAIL.md](MAIL.md)).

## A form opens on its first field and gives the focus back

A dialog or card focuses its first text field as it opens, else its first control, never a colour swatch, a tab or Cancel (`focusFirstField` in `form-shell.tsx`). When the form holds one text field with a value in it, such as a rename or a number to restart a list at, the text is selected, so typing replaces it. `DriveItemNameDialog`, which selects the name without its extension, passes `onOpenAutoFocus`. A page form focuses its first field as it mounts, and a view-first form, such as Team settings or a contact, mounts it when Edit opens it. A section with its own Save that is the first field of its page, such as the Mail signature, takes the focus on mount too.

After a save or a close the focus goes back to what opened the form ([LAYOUT.md § A closing dialog gives the focus back](LAYOUT.md#a-closing-dialog-gives-the-focus-back)). A form opened from another dialog that closes as it opens, such as Edit event from the event's detail, hands the focus to the chip the detail came from.

## A problem shows as red text under its field

A field the form can't take shows its reason under it in red: `FieldError` beside a `Field`, `FormMessage` in a react-hook-form form, with `aria-invalid` on the control. A required name or title is one `RequiredTextField` (`packages/ui/src/components/required-text-field.tsx`), and the words every form shares, such as "Add a name" or "Enter a valid email address", are `FIELD_MESSAGES` in `@workspace/lib/validation`. Save stays clickable. Pressing it with a problem shows every message and focuses the first bad field, which `FormShell` finds by `aria-invalid` once the messages have rendered. A message about a value typed wrong, such as a margin past the page, may show while typing; a missing value shows only once Save was pressed, which `useFormSubmitted()` tells the field, so a fresh form isn't red.

A form's `onSubmit` returns false to stay open after its check, and the shell takes it from there. A react-hook-form form's `handleSubmit` focuses the first error itself and never resolves false, so `FormShell` leaves that focus alone. A form still loading what it edits shows no fields, or a read-only Close. Only a picker keeps its button disabled until something is picked (`canSubmit`), since there is no field to point at. There are no browser bubbles (`FormShell` sets `noValidate`), no banners above a form and no alert dialogs.

A server answer about one field shows under that field too. Its hook skips the toast for that status and the form reads the error, as `useCreateChatRoom` (`packages/lib/src/core/chat/hooks/use-chat.ts`) does for a chat name that is taken (409), and `DriveLocationPicker` for a name its folder has already. Every other server error is a toast from `onMutationError` ([NOTIFICATIONS.md § Error toasts come from the mutation hook](NOTIFICATIONS.md#error-toasts-come-from-the-mutation-hook)).

## A running save shows a spinner in its button

While a save runs, its button shows a spinner before its label, keeps the label and ignores a click; Cancel and the footer's tools wait too. `Button`'s `pending` prop draws it with `aria-disabled` and `aria-busy` rather than `disabled`, so the focus stays on the button instead of falling to the page. Every shell, `ConfirmDialog` and the pickers pass it, so no form writes "Saving...".

The shells get `pending` from `useDialogPending`, and `useDiscardChanges` takes it, so one value says a save runs everywhere it matters. A dialog's every close path waits for the save, and a failure keeps the form open with what was typed, so the user can try again. Only a yes/no confirm closes on a refusal ([NOTIFICATIONS.md § Apps never catch a mutation error to toast it](NOTIFICATIONS.md#apps-never-catch-a-mutation-error-to-toast-it)). An error no toast has shown is rethrown by `useDialogPending`, so it reaches the console instead of leaving a button that does nothing.

## A success toast is for a result the user can't see

A dialog that closes onto what it changed toasts nothing; the change is the feedback. A form toasts when the result is out of sight: it navigated away (Personal info, Change password), the change shows nowhere (Share's "Sharing updated"), or the page stays and only its footer goes (Mail signature, Admin's draft pages, Team settings). An autosave control never toasts, since its new state is right under the pointer. The toast lives in the hook's `onSuccess` ([NOTIFICATIONS.md § A success toast is for a result the user can't see](NOTIFICATIONS.md#a-success-toast-is-for-a-result-the-user-cant-see)).

A Save that spans several writes toasts once, from one hook that runs them all in order: `useSaveServerSettingsPage` runs the name, S3 and settings writes and says "Settings saved", and `useSaveTeamSettings` runs the name, calendar and settings writes and says "Team settings saved". A failed write stops the rest, toasts once and leaves the draft on the page, and a retry sends the writes again. `useUpdateServerSettings` keeps its own toast for Guest access and Onboarding, which save only that.

## The button says what it does

One verb per job lets a user predict what a button will do before pressing it.

| Job | Label |
|---|---|
| Edit a stored thing | Save |
| Make a new thing that stands on its own, such as an event, a folder, a team or a calendar | Create |
| Put an item into something that holds it, such as a card on a board, a comment on a document, a column on a board or a person on a list | Add |
| A job with its own verb | Send, Import, Rename, Sort, Insert, Select, Reset password, Move here, Copy here, Save here |
| A format dialog in an editor, such as Page setup, a link, Data validation or a chart's data | Apply |
| The calendar's recurring choice | OK |

One word per job, so a label never says "Save changes", "Save settings" or "Let's chat". Import events and Import contacts say Import, Edit calendar says Save where New calendar says Create, and a form whose create and edit share one component switches the label with its mode. Add is not a softer Create: a card, a comment or a column lives inside its board or document, so its dialog says Add card, Add comment or Add column, while the dialogs that make an event, a folder or a team say Create.

## Delete asks unless it can be undone

Asking costs a click; a lost item costs more.

A delete that Undo or the Trash can bring back acts at once: Move to trash, a Docs table, a sheet's row. One that can't asks with a red `ConfirmDialog` first: a calendar, a label, a card, an app password, a member removed from a team, a conditional format rule in Manage rules. In a dialog the delete is a trash icon at the footer's left (`footerStart`) ([LAYOUT.md § Every yes or no is one ConfirmDialog](LAYOUT.md#every-yes-or-no-is-one-confirmdialog)).

## On a phone a form keeps its desktop shell

A dialog stays a centred box at every width and its footer stays one row: a footer tool with a text label, such as the Share dialog's Share with team, shows only its icon below the `sm` breakpoint ([LAYOUT.md § A dialog is wide unless it is small and has nothing to type in](LAYOUT.md#a-dialog-is-wide-unless-it-is-small-and-has-nothing-to-type-in)). A page form's fields stack in one column below `sm`. Big forms don't open full screen on a phone, and a long page's Save doesn't stay in view: both wait for the detail column ([ROADMAP.md](ROADMAP.md)). Side panels don't exist on a phone ([MOBILE.md § Docs panels need 769px](MOBILE.md#docs-panels-need-769px)).

## A composer sends and keeps its own draft

Chat sends on Enter, takes Shift+Enter as a line break and clears at once; Esc in its suggestion list closes the list and keeps the text. Mail never sends on Enter: Cmd+Enter sends, the draft saves itself 2.5 seconds after the last edit, and a missing recipient or subject shows under its field like any form's error. A send is not a submit, so they have no shell.

## Each rule is tested at its shell, and every form proves it uses it

`expectFormContract` (`packages/ui/src/test/form-contract.ts`, imported as `@workspace/ui/test/form-contract`) runs the probes for a form's kind on any rendered form: focus on open, one submit for Enter and for a double Enter, Cmd+Enter, Esc, the X and an outside click with and without changes (a card's Esc goes to its view), the leave guard on a page form, an invalid submit's message and focus, the pending button, and a close while the save runs. The shell's own test proves each probe against a sample form that breaks it (`form-contract.test.tsx`).

Every form then has a test of one shape. Its file mirrors the component's path under its workspace's `src/test/`, renders the real form under `installHappyDom()`, and calls `expectFormContract` once with its kind, its submit label, its first field and how to change or break it. It adds tests only for what is special about that form, such as its mutation's arguments. A form that breaks a probe on purpose names it in `except` with its reason, as Email collaborators does for plain Enter. A form whose submit writes at once, such as a Sheets dialog, passes `savesAtOnce`, and a page with no draft to lose, such as sign-in, passes `noDraft`. A layout rule, a reload's prompt or a real focus quirk can't be seen in happy-dom, so the browser pass covers those ([TESTING.md](TESTING.md)).

## See also

- [LAYOUT.md](LAYOUT.md): dialog widths, the footer, `ConfirmDialog`, focus return, keymaps that stand down under a dialog
- The [forms-and-dialogs skill](../.claude/skills/forms-and-dialogs/SKILL.md): the checklist for writing one
- [NOTIFICATIONS.md](NOTIFICATIONS.md): error and success toasts
- [MOBILE.md](MOBILE.md): phone layouts
- [SHARED-PRIMITIVES.md](SHARED-PRIMITIVES.md): `Field`, `Form`, `Button` and the other parts a form is built from
