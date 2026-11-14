// Google Docs' Tools › Word count, without its page count: the editor draws no pages to count. The toolbar opens it,
// from Tools or its shortcut for example. It counts the body's words and characters, and a selection's out of the whole.

import type { Editor } from '@tiptap/react';
import { Button } from '@workspace/ui/components/button';
import { DialogFooter } from '@workspace/ui/components/dialog';
import { FormDialog } from '@workspace/ui/components/form-dialog';
import { useState } from 'react';
import type { TextCounts } from './word-count';
import { countWords } from './word-count';

type WordCountDialogProps = {
    // The editor counted.
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus: (event: Event) => void;
};

const ROWS: { key: keyof TextCounts; label: string }[] = [
    { key: 'words', label: 'Words' },
    { key: 'characters', label: 'Characters' },
    { key: 'charactersExcludingSpaces', label: 'Characters excluding spaces' },
];

export function WordCountDialog({ editor, open, onOpenChange, onCloseAutoFocus }: WordCountDialogProps) {
    return (
        <FormDialog
            open={open}
            onOpenChange={onOpenChange}
            title="Word count"
            size="sm"
            onCloseAutoFocus={onCloseAutoFocus}
        >
            <WordCounts editor={editor} />
            <DialogFooter>
                <Button onClick={() => onOpenChange(false)}>OK</Button>
            </DialogFooter>
        </FormDialog>
    );
}

// Mounted with the dialog, so it counts once as it opens rather than on every transaction.
function WordCounts({ editor }: { editor: Editor }) {
    const [{ document: whole, selection }] = useState(() => countWords(editor.state));
    const format = (n: number) => n.toLocaleString('en');

    return (
        <dl className="text-sm space-y-1.5">
            {ROWS.map(({ key, label }) => (
                <div key={key} className="flex justify-between items-baseline gap-4">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="tabular-nums">
                        {selection ? `${format(selection[key])} of ${format(whole[key])}` : format(whole[key])}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
