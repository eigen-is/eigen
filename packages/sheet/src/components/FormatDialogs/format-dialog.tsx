// The parts the custom format dialogs share, such as Custom number formats: the dialog whose Apply sets one number
// format on the selection, the line under its field that previews the format or says why it can't be applied, and the
// list of presets with the one in use marked. A format typed wrong says so as it is typed, and an empty one once Apply
// was pressed.

import { FieldError } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { useFormSubmitted } from '@workspace/ui/components/form-shell';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import { handleNumberFormat } from '../../state';
import type { FormatPreview } from './format-pattern';

// `error` says what is wrong with the format as typed, and `missing` what an empty one lacks. The fields get the
// problem to show now.
export function FormatDialog({
    title,
    pattern,
    changed,
    error,
    missing,
    children,
}: {
    title: string;
    pattern: string;
    changed: boolean;
    error?: string;
    missing?: string;
    children: (problem: string | undefined) => ReactNode;
}) {
    const { setContext, refs } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();

    return (
        <FormDialog {...dialogProps} title={title}>
            <FormDialogForm
                submitLabel="Apply"
                changed={changed}
                onSubmit={() => {
                    if (error ?? missing) return false;
                    setContext((ctx) => {
                        const cellInput = refs.cellInput.current;
                        if (!cellInput) return;
                        handleNumberFormat(ctx, cellInput, pattern);
                    });
                }}
            >
                <FormatFields error={error} missing={missing}>
                    {children}
                </FormatFields>
            </FormDialogForm>
        </FormDialog>
    );
}

// Inside the form, where it knows whether Apply was pressed.
function FormatFields({
    error,
    missing,
    children,
}: {
    error?: string;
    missing?: string;
    children: (problem: string | undefined) => ReactNode;
}) {
    const submitted = useFormSubmitted();
    return children(error ?? (submitted ? missing : undefined));
}

// The format shown on the dialog's sample value, or the problem its field points at by `id`.
export function PatternPreview({ id, preview, problem }: { id: string; preview: FormatPreview; problem?: string }) {
    if (problem) return <FieldError id={id}>{problem}</FieldError>;
    return (
        preview.ok && (
            <div className="text-sm text-muted-foreground">
                Preview: <span className="text-foreground">{preview.text}</span>
            </div>
        )
    );
}

// A list of presets that scrolls inside the dialog, so the footer stays on screen.
export function PresetList({ children }: { children: ReactNode }) {
    return <div className="max-h-[40vh] border border-border rounded-md overflow-y-auto">{children}</div>;
}

// A button, so the keyboard picks a preset with Enter or Space as the mouse does.
export function PresetRow({ active, onPick, children }: { active: boolean; onPick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className={cn(
                'flex w-full items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item',
                active && 'eigen-list-item-active',
            )}
            onClick={onPick}
        >
            {children}
        </button>
    );
}
