// The Row height and Column width dialog, opened from a row or column header's menu. It sets every selected row or
// column to one size in pixels, and opens on their size when they all share one. A size the engine can't take says
// why under the field as it is typed, and an empty one once Apply is pressed.

import { Field, FieldError } from '@workspace/ui/components/field';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useId, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import { api, getSheetConfig } from '../../state';

// The engine's limits, in pixels.
const MAX_SIZE = { row: 545, column: 2038 } as const;

export function ResizeDialog({ mode }: { mode: 'row' | 'column' }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const isRow = mode === 'row';

    const selectedIndices = useMemo(() => {
        const indexSet = new Set<number>();
        for (const s of context.selections ?? []) {
            const [start, end] = isRow ? s.row : s.column;
            for (let i = start; i <= end; i += 1) indexSet.add(i);
        }
        return [...indexSet];
    }, [context.selections, isRow]);

    // The size they all share, else empty.
    const [opened] = useState(() => {
        const cfg = getSheetConfig(context);
        const lenMap = isRow ? cfg?.rowlen : cfg?.columnlen;
        const fallback = isRow ? context.defaultrowlen : context.defaultcollen;
        const sizes = selectedIndices.map((i) => lenMap?.[i] ?? fallback);
        const uniformSize = sizes.length > 0 && sizes.every((v) => v === sizes[0]) ? sizes[0] : null;
        return uniformSize != null ? String(uniformSize) : '';
    });
    const [value, setValue] = useState(opened);
    // Why the last Apply was refused, until the next edit.
    const [refusal, setRefusal] = useState<string>();
    const reasonId = useId();

    const size = Number(value);
    const rangeMessage = `Enter a value between 1 and ${MAX_SIZE[mode]}.`;
    const outOfRange = value !== '' && !(Number.isInteger(size) && size >= 1 && size <= MAX_SIZE[mode]);
    const reason = outOfRange ? rangeMessage : refusal;

    const apply = () => {
        if (value === '' || outOfRange) {
            setRefusal(rangeMessage);
            return false;
        }
        if (selectedIndices.length === 0) {
            setRefusal(isRow ? 'Select the rows to resize first.' : 'Select the columns to resize first.');
            return false;
        }
        setContext((draftCtx) => {
            const sizeMap: Record<string, number> = {};
            for (const i of selectedIndices) sizeMap[i] = size;
            if (isRow) api.setRowHeight(draftCtx, sizeMap, true);
            else api.setColumnWidth(draftCtx, sizeMap, true);
        });
    };

    return (
        <FormDialog {...dialogProps} title={isRow ? 'Row height' : 'Column width'}>
            <FormDialogForm submitLabel="Apply" changed={value !== opened} onSubmit={apply}>
                <Field>
                    <div className="flex items-center gap-2">
                        <Input
                            type="number"
                            min={1}
                            max={MAX_SIZE[mode]}
                            value={value}
                            className="w-24"
                            aria-label={isRow ? 'Row height in pixels' : 'Column width in pixels'}
                            aria-invalid={reason !== undefined}
                            aria-describedby={reason ? reasonId : undefined}
                            onChange={(e) => {
                                setValue(e.target.value);
                                setRefusal(undefined);
                            }}
                        />
                        <span className="text-sm text-muted-foreground">px</span>
                    </div>
                    {reason && <FieldError id={reasonId}>{reason}</FieldError>}
                </Field>
            </FormDialogForm>
        </FormDialog>
    );
}
