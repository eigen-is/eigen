import type { Editor } from '@tiptap/react';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldLabel } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';
import { restartNumbering } from './list-numbering';

type RestartNumberingDialogProps = {
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

// Google Docs' List options › Restart numbering, at the item the caret is in.
export function RestartNumberingDialog({ editor, open, onOpenChange }: RestartNumberingDialogProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                size="sm"
                showCloseButton={false}
                aria-describedby={undefined}
                onCloseAutoFocus={(e) => {
                    e.preventDefault();
                    editor.commands.focus();
                }}
            >
                <DialogHeader>
                    <DialogTitle>Restart numbering</DialogTitle>
                </DialogHeader>
                <RestartNumberingForm editor={editor} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog, so each opening starts at 1.
function RestartNumberingForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
    const [startAt, setStartAt] = useState('1');
    const start = Number(startAt);
    const valid = Number.isInteger(start) && start >= 1;

    return (
        <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                restartNumbering(editor, start);
                onDone();
            }}
        >
            <Field orientation="horizontal">
                <FieldLabel htmlFor="restart-numbering-start">Start at</FieldLabel>
                <Input
                    id="restart-numbering-start"
                    type="number"
                    min={1}
                    className="w-24"
                    autoFocus
                    value={startAt}
                    onChange={(e) => setStartAt(e.target.value)}
                />
            </Field>
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                    OK
                </Button>
            </DialogFooter>
        </form>
    );
}
