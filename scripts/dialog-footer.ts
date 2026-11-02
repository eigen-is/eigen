// The standards check for dialog footers. A dialog with fields and Cancel/submit is a FormDialog with a FormDialogForm,
// which draws its footer, so a source file that uses DialogFooter fails unless OWN_DIALOG_FOOTER lists it with a reason.
// It only sees DialogFooter: a footer drawn by hand passes. An entry whose file no longer uses DialogFooter fails too, so
// the list only shrinks and a dialog that moves leaves it in the same commit.

import type { SourceFile } from './unused-primitives';

// The dialogs that draw their own footer: they are not a form, or not yet moved onto FormDialog.
export const OWN_DIALOG_FOOTER = new Set([
    'apps/calendar/src/components/event-detail-dialog.tsx', // actions, no fields
    'apps/docs/src/components/docs/word-count-dialog.tsx', // information only, in a FormDialog shell
    'apps/drive/src/components/editor/conflict-dialog.tsx', // three actions
    'apps/mail/src/components/mail/email-draft.tsx', // an alert with one OK button
    'apps/mail/src/components/mail/mail-shortcuts-dialog.tsx', // information only
    'apps/mail/src/components/mail/share-and-send-dialog.tsx', // three actions
    // Sheet dialogs not yet moved onto FormDialog.
    'packages/sheet/src/components/CellRangeDialog/index.tsx',
    'packages/sheet/src/components/ConditionFormat/ConditionRules.tsx',
    'packages/sheet/src/components/ConditionFormat/ManageRules.tsx',
    'packages/sheet/src/components/CustomSort/index.tsx',
    'packages/sheet/src/components/DataVerification/index.tsx',
    'packages/sheet/src/components/FormatDialogs/CustomCurrencies.tsx',
    'packages/sheet/src/components/FormatDialogs/CustomDateTimeFormats.tsx',
    'packages/sheet/src/components/FormatDialogs/CustomNumberFormats.tsx',
    'packages/sheet/src/components/InsertFunctionDialog/index.tsx',
    'packages/sheet/src/components/LinkEditCard/index.tsx',
    'packages/sheet/src/components/ResizeDialog/index.tsx',
    'packages/sheet/src/components/SplitColumn/index.tsx',
    'packages/sheet/src/hooks/useDialog.tsx', // a notice or a yes or no
    'packages/ui/src/components/cards/card-form.tsx', // the edit view a card dialog swaps in for its view
    'packages/ui/src/components/charts/chart-data-dialog.tsx', // a grid
    'packages/ui/src/components/chat/chat-create-wizard.tsx', // several steps
    'packages/ui/src/components/confirm-dialog.tsx', // a yes or no
    'packages/ui/src/components/drive/drive-file-picker.tsx', // a picker
    'packages/ui/src/components/drive/drive-location-picker.tsx', // a picker
    'packages/ui/src/components/layout/app/about-dialog.tsx', // information only
]);

type DialogFooterHits = {
    // Files that use DialogFooter and are not on the list.
    outside: string[];
    // Entries of the list whose file no longer uses DialogFooter, or is gone.
    stale: string[];
};

// The files that define DialogFooter and the one shell that draws it for every form.
const FOOTER_HOMES = new Set(['packages/ui/src/components/dialog.tsx', 'packages/ui/src/components/form-dialog.tsx']);
// A test renders dialogs as fixtures, so its footer is no new dialog.
const TEST_FILE = /\/src\/test\/|\.test\.tsx?$/;
// Read in the code with comments and strings blanked, so a mention in a comment or a string does not count.
const USES_FOOTER = /\bDialogFooter\b/;

export function dialogFooterHits(sources: SourceFile[]): DialogFooterHits {
    const users = new Set(sources.filter(({ code }) => USES_FOOTER.test(code)).map(({ path }) => path));
    return {
        outside: [...users].filter(
            (path) => !OWN_DIALOG_FOOTER.has(path) && !FOOTER_HOMES.has(path) && !TEST_FILE.test(path),
        ),
        stale: [...OWN_DIALOG_FOOTER].filter((path) => !users.has(path)),
    };
}
