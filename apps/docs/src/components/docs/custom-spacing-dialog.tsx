// Google Docs' Format › Line & paragraph spacing › Custom spacing: the line spacing, and the space before and after in
// points, for the paragraphs the selection spans. The toolbar opens it, and Apply writes only the fields that changed.

import type { Editor } from '@tiptap/react';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import { PARAGRAPH_FORMAT_LIMITS, selectionParagraphFormat } from '@workspace/lib/docs/eigendoc';
import { Field, FieldError, FieldLabel, FieldLegend, FieldSet } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useId, useState } from 'react';

type CustomSpacingDialogProps = {
    editor: Editor;
    // The doc's Normal, which an unformatted paragraph draws.
    normal: NormalStyle;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCloseAutoFocus: (event: Event) => void;
};

const LABELS = { lineSpacing: 'Line spacing', spaceBefore: 'Before', spaceAfter: 'After' } as const;

type SpacingKey = keyof typeof LABELS;

const KEYS = ['lineSpacing', 'spaceBefore', 'spaceAfter'] as const satisfies readonly SpacingKey[];

const fieldText = (value: number) => String(Math.round(value * 100) / 100);

export function CustomSpacingDialog({
    editor,
    normal,
    open,
    onOpenChange,
    onCloseAutoFocus,
}: CustomSpacingDialogProps) {
    return (
        <FormDialog open={open} onOpenChange={onOpenChange} title="Custom spacing" onCloseAutoFocus={onCloseAutoFocus}>
            <CustomSpacingForm editor={editor} normal={normal} />
        </FormDialog>
    );
}

// Mounted with the dialog, so each opening starts from what the selection's first paragraph draws. A list, a quote and a
// table cell own the space around what they hold, so there only the line spacing is the paragraph's.
function CustomSpacingForm({ editor, normal }: { editor: Editor; normal: NormalStyle }) {
    const [{ drawn: initial, spacing }] = useState(() => selectionParagraphFormat(editor.state, editor.view, normal));
    const [text, setText] = useState<Record<SpacingKey, string>>(() => ({
        lineSpacing: fieldText(initial.lineSpacing),
        spaceBefore: fieldText(initial.spaceBefore),
        spaceAfter: fieldText(initial.spaceAfter),
    }));
    // An untouched field writes nothing, so an unset paragraph keeps the doc's Normal.
    const edited = KEYS.filter((key) => text[key] !== fieldText(initial[key]));
    const invalid = (key: SpacingKey) => {
        const value = text[key].trim() ? Number(text[key]) : Number.NaN;
        const { min, max } = PARAGRAPH_FORMAT_LIMITS[key];
        return edited.includes(key) && !(value >= min && value <= max);
    };
    const valid = !KEYS.some(invalid);
    const errorId = useId();

    const field = (key: SpacingKey) => (
        <Field orientation="horizontal">
            <FieldLabel htmlFor={`custom-spacing-${key}`}>{LABELS[key]}</FieldLabel>
            <Input
                id={`custom-spacing-${key}`}
                type="number"
                step="any"
                className="w-24"
                aria-invalid={invalid(key) || undefined}
                aria-describedby={invalid(key) ? errorId : undefined}
                disabled={key !== 'lineSpacing' && !spacing}
                value={text[key]}
                onChange={(e) => setText({ ...text, [key]: e.target.value })}
            />
        </Field>
    );

    return (
        <FormDialogForm
            submitLabel="Apply"
            changed={edited.length > 0}
            onSubmit={() => {
                if (!valid) return false;
                const format: { [key in SpacingKey]?: number } = {};
                for (const key of edited) format[key] = Number(text[key]);
                if (edited.length > 0) editor.chain().focus().setParagraphFormat(format).run();
            }}
        >
            {field('lineSpacing')}
            <FieldSet className="gap-3">
                <FieldLegend variant="label">Paragraph spacing (points)</FieldLegend>
                {field('spaceBefore')}
                {field('spaceAfter')}
            </FieldSet>
            {!valid && (
                <FieldError id={errorId}>
                    Line spacing must be between {PARAGRAPH_FORMAT_LIMITS.lineSpacing.min} and{' '}
                    {PARAGRAPH_FORMAT_LIMITS.lineSpacing.max}, and spacing between{' '}
                    {PARAGRAPH_FORMAT_LIMITS.spaceBefore.min} and {PARAGRAPH_FORMAT_LIMITS.spaceBefore.max} points.
                </FieldError>
            )}
        </FormDialogForm>
    );
}
