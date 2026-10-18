import type { Editor } from '@tiptap/react';
import { PARAGRAPH_FORMAT_LIMITS, selectionParagraphFormat } from '@workspace/lib/docs/eigendoc';
import { Button } from '@workspace/ui/components/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import { useState } from 'react';

type CustomSpacingDialogProps = {
    editor: Editor;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

const LABELS = { lineSpacing: 'Line spacing', spaceBefore: 'Before', spaceAfter: 'After' } as const;

type SpacingKey = keyof typeof LABELS;

const KEYS = ['lineSpacing', 'spaceBefore', 'spaceAfter'] as const satisfies readonly SpacingKey[];

const fieldText = (value: number) => String(Math.round(value * 100) / 100);

// Google Docs' Format › Line & paragraph spacing › Custom spacing, on the paragraphs the selection spans.
export function CustomSpacingDialog({ editor, open, onOpenChange }: CustomSpacingDialogProps) {
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
                    <DialogTitle>Custom spacing</DialogTitle>
                </DialogHeader>
                <CustomSpacingForm editor={editor} onDone={() => onOpenChange(false)} />
            </DialogContent>
        </Dialog>
    );
}

// Mounted with the dialog, so each opening starts from what the selection's first paragraph draws. A list, a quote and a
// table cell own the space around what they hold, so there only the line spacing is the paragraph's.
function CustomSpacingForm({ editor, onDone }: { editor: Editor; onDone: () => void }) {
    const [{ drawn: initial, spacing }] = useState(() => selectionParagraphFormat(editor.state, editor.view));
    const [text, setText] = useState<Record<SpacingKey, string>>(() => ({
        lineSpacing: fieldText(initial.lineSpacing),
        spaceBefore: fieldText(initial.spaceBefore),
        spaceAfter: fieldText(initial.spaceAfter),
    }));
    // An untouched field writes nothing, so an unset paragraph keeps the doc's look.
    const changed = KEYS.filter((key) => text[key] !== fieldText(initial[key]));
    const valid = changed.every((key) => {
        const value = text[key].trim() ? Number(text[key]) : Number.NaN;
        const { min, max } = PARAGRAPH_FORMAT_LIMITS[key];
        return value >= min && value <= max;
    });

    const field = (key: SpacingKey, autoFocus?: boolean) => (
        <Field orientation="horizontal">
            <FieldLabel htmlFor={`custom-spacing-${key}`}>{LABELS[key]}</FieldLabel>
            <Input
                id={`custom-spacing-${key}`}
                type="number"
                step="any"
                className="w-24"
                autoFocus={autoFocus}
                disabled={key !== 'lineSpacing' && !spacing}
                value={text[key]}
                onChange={(e) => setText({ ...text, [key]: e.target.value })}
            />
        </Field>
    );

    return (
        <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                const format: { [key in SpacingKey]?: number } = {};
                for (const key of changed) format[key] = Number(text[key]);
                if (changed.length > 0) editor.chain().focus().setParagraphFormat(format).run();
                onDone();
            }}
        >
            {field('lineSpacing', true)}
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Paragraph spacing (points)</FieldLegend>
                {field('spaceBefore')}
                {field('spaceAfter')}
            </FieldSet>
            {!valid && (
                <FieldError>
                    Line spacing must be between {PARAGRAPH_FORMAT_LIMITS.lineSpacing.min} and{' '}
                    {PARAGRAPH_FORMAT_LIMITS.lineSpacing.max}, and spacing between{' '}
                    {PARAGRAPH_FORMAT_LIMITS.spaceBefore.min} and {PARAGRAPH_FORMAT_LIMITS.spaceBefore.max} points.
                </FieldError>
            )}
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
