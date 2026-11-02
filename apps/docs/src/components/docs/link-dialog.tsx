// Google Docs' Insert › Link: a URL that links the selected text, or goes in at the caret as a link of its own. The
// toolbar opens it, from Insert or the icon row's Add link for example, when the caret is not on a link already.

import type { Editor } from '@tiptap/react';
import { FormDialog, FormDialogForm } from '@workspace/ui';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type LinkDialogProps = {
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus: (event: Event) => void;
};

export function LinkDialog({ editor, open, onOpenChange, onCloseAutoFocus }: LinkDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Add link"
            size="sm"
            onCloseAutoFocus={onCloseAutoFocus}
        >
            <LinkForm editor={editor} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts with an empty URL.
function LinkForm({ editor }: { editor: Editor }) {
    const [url, setUrl] = useState('');
    const href = url.trim();

    return (
        <FormDialogForm
            canSubmit={href !== ''}
            submitLabel="Add link"
            onSubmit={() => {
                const { from, to } = editor.state.selection;
                if (from === to) {
                    editor
                        .chain()
                        .focus()
                        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
                        .run();
                } else {
                    editor.chain().focus().setLink({ href }).run();
                }
            }}
        >
            <Field>
                <FieldLabel htmlFor="link-url">URL</FieldLabel>
                <Input
                    id="link-url"
                    autoFocus
                    placeholder="https://example.com"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                />
            </Field>
        </FormDialogForm>
    );
}
