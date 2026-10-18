import type { Editor } from '@tiptap/react';
import { cmText, readCm, readParagraphFormat, selectionParagraphFormat } from '@workspace/lib/docs/eigendoc';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useState } from 'react';

type IndentationOptionsDialogProps = {
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const SPECIAL_INDENTS = [
    { value: 'none', label: 'None' },
    { value: 'firstLine', label: 'First line' },
    { value: 'hanging', label: 'Hanging' },
] as const;

type SpecialIndent = (typeof SPECIAL_INDENTS)[number]['value'];

// Indents are stored in pt and shown in cm to 0.01, as Google shows 0.5 in as 1.27 cm.
const cm = (pt: number) => cmText((pt * 25.4) / 72, 2);
const pt = (text: string) => (readCm(text) * 72) / 25.4;

// Google Docs' Format › Align and indent › Indentation options, on the paragraphs the selection spans.
export function IndentationOptionsDialog({ editor, open, onOpenChange }: IndentationOptionsDialogProps) {
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
                    <DialogTitle>Indentation options</DialogTitle>
                </DialogHeader>
                <IndentationOptionsForm editor={editor} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog, so each opening starts from the selection's first paragraph. As in Google and Word, Left is
// where the body lines stand, and a first line or hanging indent moves the first line right or left of it.
function IndentationOptionsForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
    const [initial] = useState(() => {
        const { indentLeft, indentRight, indentFirstLine } = selectionParagraphFormat(editor.state, editor.view).drawn;
        const special: SpecialIndent = indentFirstLine > 0 ? 'firstLine' : indentFirstLine < 0 ? 'hanging' : 'none';
        return {
            left: indentLeft,
            right: indentRight,
            by: Math.abs(indentFirstLine),
            special,
            format: { indentLeft, indentRight, indentFirstLine },
        };
    });
    const [special, setSpecial] = useState(initial.special);
    const [text, setText] = useState({ left: cm(initial.left), right: cm(initial.right), by: cm(initial.by) });

    // An untouched field keeps the stored length, not its rounding.
    const length = (key: 'left' | 'right' | 'by') => (text[key] === cm(initial[key]) ? initial[key] : pt(text[key]));
    const left = length('left');
    const by = special === 'none' ? 0 : length('by');
    const valid = [left, length('right'), by].every((value) => value >= 0);
    const candidate = readParagraphFormat({
        indentLeft: left,
        indentRight: length('right'),
        indentFirstLine: special === 'hanging' ? -by : by,
    });

    return (
        <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                // Only what changed, no indent as none.
                const format: Partial<Record<keyof typeof initial.format, number | null>> = {};
                for (const key of ['indentLeft', 'indentRight', 'indentFirstLine'] as const) {
                    const value = candidate[key] ?? 0;
                    if (value !== initial.format[key]) format[key] = value === 0 ? null : value;
                }
                editor.chain().focus().setParagraphFormat(format).run();
                onDone();
            }}
        >
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Indentation (centimetres)</FieldLegend>
                {(['left', 'right'] as const).map((key) => (
                    <Field key={key} orientation="horizontal">
                        <FieldLabel htmlFor={`indentation-${key}`}>{key === 'left' ? 'Left' : 'Right'}</FieldLabel>
                        <Input
                            id={`indentation-${key}`}
                            type="number"
                            step="any"
                            min={0}
                            className="w-24"
                            autoFocus={key === 'left'}
                            value={text[key]}
                            onChange={(e) => setText({ ...text, [key]: e.target.value })}
                        />
                    </Field>
                ))}
            </FieldSet>
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Special indent</FieldLegend>
                <Field orientation="horizontal">
                    <FieldLabel htmlFor="indentation-special" className="sr-only">
                        Special indent
                    </FieldLabel>
                    <Select
                        value={special}
                        onValueChange={(value) =>
                            setSpecial(SPECIAL_INDENTS.find((s) => s.value === value)?.value ?? 'none')
                        }
                    >
                        <SelectTrigger id="indentation-special" className="w-36">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SPECIAL_INDENTS.map(({ value, label }) => (
                                <SelectItem key={value} value={value}>
                                    {label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                    <FieldLabel htmlFor="indentation-by" className="sr-only">
                        By
                    </FieldLabel>
                    <Input
                        id="indentation-by"
                        type="number"
                        step="any"
                        min={0}
                        className="w-24"
                        disabled={special === 'none'}
                        value={special === 'none' ? '' : text.by}
                        onChange={(e) => setText({ ...text, by: e.target.value })}
                    />
                </Field>
            </FieldSet>
            {!valid && <FieldError>Indents must be 0 cm or more.</FieldError>}
            <DialogFooter>
                <Button type="button" variant="outline" onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={!valid}>
                    Apply
                </Button>
            </DialogFooter>
        </form>
    );
}
