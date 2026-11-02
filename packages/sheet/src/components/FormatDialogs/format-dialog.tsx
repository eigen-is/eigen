// The parts the custom format dialogs share, such as Custom number formats: the dialog whose Apply sets one number
// format on the selection, the line that previews the format, and the list of presets with the one in use marked.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import { handleNumberFormat } from '../../state';
import type { FormatPreview } from './format-pattern';

export function FormatDialog({
    title,
    pattern,
    canSubmit,
    children,
}: {
    title: string;
    pattern: string;
    canSubmit: boolean;
    children: ReactNode;
}) {
    const { setContext, refs } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();

    return (
        <FormDialog {...dialogProps} title={title} size="md">
            <FormDialogForm
                submitLabel="Apply"
                canSubmit={canSubmit}
                onSubmit={() =>
                    setContext((ctx) => {
                        const cellInput = refs.cellInput.current;
                        if (!cellInput) return;
                        handleNumberFormat(ctx, cellInput, pattern);
                    })
                }
            >
                {children}
            </FormDialogForm>
        </FormDialog>
    );
}

// The format shown on the dialog's sample value, or why the format can't be read.
export function PatternPreview({ preview }: { preview: FormatPreview }) {
    return preview.ok ? (
        <div className="text-sm text-muted-foreground">
            Preview: <span className="text-foreground">{preview.text}</span>
        </div>
    ) : (
        <div className="text-sm text-destructive">{preview.error}</div>
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
