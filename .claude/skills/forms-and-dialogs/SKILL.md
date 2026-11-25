---
name: forms-and-dialogs
description: Use when writing or changing a form in Eigen, including a dialog with fields, a picker, a confirm, a settings page, an Admin draft page, a card's add or edit form, or any place a user types or picks something that Eigen then saves. Also when adding a Save, Create, Apply or Cancel button, wiring Enter, Cmd+Enter or Esc on a form, a "Discard changes?" or leave guard, a field's error message, a button's saving spinner, a delete that asks, or a form's test.
---

# Forms and dialogs

The rules live in [docs/FORMS.md](../../../docs/FORMS.md), how a form behaves, and in [LAYOUT.md](../../../docs/LAYOUT.md#a-dialog-is-wide-unless-it-is-small-and-has-nothing-to-type-in) from "A dialog is wide unless it is small" to "A dialog opened by a value keeps it while it closes", how a dialog looks. Read both before you write the form. A form gets its rules by sitting on its shell (`FormDialog` + `FormDialogForm`, `CardForm`, `PageForm`, all on `FormShell`); never rebuild one beside it, and a missing feature goes into the shell.

## Checklist

- **Width**: `lg`, the default, unless the dialog is small and has nothing to type in; then `size="sm"`.
- **Footer**: one row. Tools about the item at the left (`footerStart`), Cancel and the main button at the right. A text tool is a `FooterTool`, which hides its label below `sm`.
- **Label**: Save edits a stored thing, Create makes a new one, unless the job has its own verb (Send, Import, Rename, Sort, Insert, Move here). An editor's format dialog says Apply; the calendar's recurring choice says OK. Never "Save changes" or "Saving...".
- **Enter and Cmd+Enter**: the shell submits on both; a rich-text field passes `submitOnModEnter`. Add no key handler of your own.
- **Esc and Discard**: pass `changed` (react-hook-form: `formState.isDirty`; otherwise compare with what it loaded). Esc, the X and an outside click then ask "Discard changes?"; Cancel never asks. A typed people field ORs `hasText` into `changed` and calls `commitTyped()` first in the submit. A page form's leave guard asks even while it saves, so its own navigation after the save, and Cancel's, pass `ignoreBlocker: true`.
- **Focus**: the first text field takes it by itself; pass `onOpenAutoFocus` only for a special selection, as Rename does.
- **`pending`**: the shells pass it to the button. A dialog you build on `ConfirmDialog` or a picker takes it too, never `disabled` or a label while saving.
- **Errors under the field**: `FieldError` or `FormMessage` with `aria-invalid`, a missing value only after `useFormSubmitted()`. A required name or title is a `RequiredTextField`; shared wordings are `FIELD_MESSAGES` (`@workspace/lib/validation`). `onSubmit` returns false to stay. Save stays clickable; no `canSubmit` except a picker with nothing picked. A server refusal about one field skips its toast in the hook and shows under the field.
- **Delete**: acts at once when Undo or the Trash brings it back, else a red `ConfirmDialog`; in a dialog a trash icon in `footerStart`.
- **Phone**: the dialog stays a box with a one-row footer; a page form's grid is `grid-cols-1 sm:grid-cols-2`.
- **Test shape**: one file mirroring the component under the workspace's `src/test/`, the real form under `installHappyDom()`, one `expectFormContract({ kind, render, submitLabel, firstField, onSubmit, makeChanged, makeInvalid?, invalidField? })` from `@workspace/ui/test/form-contract`, then only what is special about the form. A probe the form breaks on purpose goes in `except` with its reason; a submit that writes at once passes `savesAtOnce`, a page with nothing to lose `noDraft`. Type with the helper's `type` and find fields with its `field`.

Run the workspace's tests for the form, then follow the source-file skill on each file you touched.
