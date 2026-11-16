// The Docs editor's Insert link and Edit link dialog, with the fields and words of the sheet's link dialog. It links the
// selected text to a web page, or at a bare caret inserts what Display text holds as a new link. Selected text keeps
// its formatting, so its box only shows it. The editor opens it from the toolbar, Insert and a link's right-click menu
// on a range: linkDialogTarget widens the selection to a link it lies in, so the dialog edits that link whole.

import { getMarkRange } from '@tiptap/core';
import type { Editor } from '@tiptap/react';
import { webLinkHref } from '@workspace/lib/validation';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { LinkAddressField, LinkTextField } from '@workspace/ui/components/link-fields';
import { useState } from 'react';

// href is the link being edited, or empty for a new one. The selection stays as it is until OK.
export type LinkDialogTarget = { editor: Editor; from: number; to: number; href: string };

export function linkDialogTarget(editor: Editor): LinkDialogTarget {
    const { $from, from, to } = editor.state.selection;
    const type = editor.schema.marks['link'];
    const link = type && getMarkRange($from, type);
    const range = link && link.from <= from && link.to >= to ? link : { from, to };
    const { href = '' } = editor.getAttributes('link');
    return { editor, ...range, href };
}

type LinkDialogProps = LinkDialogTarget & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus: (event: Event) => void;
};

export function LinkDialog({ open, onOpenChange, onCloseAutoFocus, ...target }: LinkDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title={target.href ? 'Edit link' : 'Insert link'}
            size="md"
            onCloseAutoFocus={onCloseAutoFocus}
        >
            <LinkForm {...target} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from its target.
function LinkForm({ editor, from, to, href }: LinkDialogTarget) {
    const atCaret = from === to;
    const [text, setText] = useState(() => editor.state.doc.textBetween(from, to, ' '));
    const [address, setAddress] = useState(href);
    const linkHref = webLinkHref(address);

    return (
        <FormDialogForm
            canSubmit={linkHref != null}
            submitLabel="OK"
            onSubmit={() => {
                if (linkHref == null) return false;
                // The caret ends after the link, as a selection left on it would be replaced by the next key.
                if (atCaret) {
                    const link = { type: 'link', attrs: { href: linkHref } };
                    editor
                        .chain()
                        .focus()
                        .insertContentAt(from, { type: 'text', text: text || linkHref, marks: [link] })
                        .run();
                } else {
                    editor
                        .chain()
                        .focus()
                        .setTextSelection({ from, to })
                        .setLink({ href: linkHref })
                        .setTextSelection(to)
                        .run();
                }
            }}
        >
            <div className="space-y-3">
                <LinkTextField value={text} onValueChange={setText} disabled={!atCaret} />
                <LinkAddressField value={address} onValueChange={setAddress} autoFocus />
            </div>
        </FormDialogForm>
    );
}
