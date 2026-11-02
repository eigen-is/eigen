// The Custom number formats dialog: a pattern field with the format of the focus cell, a live preview on a
// sample value, and presets. Apply sets the pattern on the selection through handleNumberFormat.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialogProps } from '../../hooks/useDialog';
import { handleNumberFormat } from '../../state';
import { NUMBER_FORMAT_PRESETS, previewPattern } from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

export function CustomNumberFormats() {
    const { setContext, refs } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();

    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const sampleValue = typeof anchor?.v === 'number' ? anchor.v : 1234.56;
    const [pattern, setPattern] = useState(
        anchorFa && anchorFa !== 'General' && anchorFa !== '@' ? anchorFa : '#,##0.00',
    );

    const sample = previewPattern(pattern, sampleValue);

    return (
        <FormDialog {...dialogProps} title="Custom number formats" size="md">
            <FormDialogForm
                submitLabel="Apply"
                canSubmit={!!pattern && sample.ok}
                onSubmit={() =>
                    setContext((ctx) => {
                        const cellInput = refs.cellInput.current;
                        if (!cellInput) return;
                        handleNumberFormat(ctx, cellInput, pattern);
                    })
                }
            >
                <div className="flex flex-col gap-1.5">
                    <Input
                        className="font-mono"
                        aria-label="Number format"
                        value={pattern}
                        onChange={(e) => setPattern(e.target.value)}
                    />
                    {sample.ok ? (
                        <div className="text-sm text-muted-foreground">
                            Sample: <span className="text-foreground">{sample.text}</span>
                        </div>
                    ) : (
                        <div className="text-sm text-destructive">{sample.error}</div>
                    )}
                </div>
                <div className="max-h-[40vh] border border-border rounded-md overflow-y-auto">
                    {NUMBER_FORMAT_PRESETS.map((preset) => (
                        <div
                            className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item"
                            key={preset}
                            onClick={() => setPattern(preset)}
                            tabIndex={0}
                        >
                            <span className="font-mono">{preset}</span>
                            <span className="text-muted-foreground">{update(preset, sampleValue)}</span>
                        </div>
                    ))}
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}
