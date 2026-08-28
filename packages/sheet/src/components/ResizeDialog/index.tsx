import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { api, type Context, getSheetConfig } from '../../state';

// Engine limits, in pixels. The legacy inline item validated column width to 2038
// but capped its <input> at 545 (copy-pasted from the row case) — fixed here.
const MAX_SIZE = { row: 545, column: 2038 } as const;

export function ResizeDialog({ mode }: { mode: 'row' | 'column' }) {
    const { context, setContext } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();
    const isRow = mode === 'row';

    // The selection can't change while the dialog is open, so compute once per open.
    const selectedIndices = useMemo(() => {
        const indexSet = new Set<number>();
        for (const s of context.selections ?? []) {
            const [start, end] = isRow ? s.row : s.column;
            for (let i = start; i <= end; i += 1) indexSet.add(i);
        }
        return [...indexSet];
    }, [context.selections, isRow]);

    // Prefill with the current size when every selected row/column shares it, else blank.
    const [value, setValue] = useState(() => {
        const cfg = getSheetConfig(context);
        const lenMap = isRow ? cfg?.rowlen : cfg?.columnlen;
        const fallback = isRow ? context.defaultrowlen : context.defaultcollen;
        const sizes = selectedIndices.map((i) => lenMap?.[i] ?? fallback);
        const uniformSize = sizes.length > 0 && sizes.every((v) => v === sizes[0]) ? sizes[0] : null;
        return uniformSize != null ? String(uniformSize) : '';
    });
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const size = Number(value);
    const isValid =
        value !== '' && Number.isInteger(size) && size >= 1 && size <= MAX_SIZE[mode] && selectedIndices.length > 0;

    const apply = () => {
        if (!isValid) return;
        setContext((draftCtx: Context) => {
            const sizeMap: Record<string, number> = {};
            for (const i of selectedIndices) sizeMap[i] = size;
            if (isRow) api.setRowHeight(draftCtx, sizeMap, {}, true);
            else api.setColumnWidth(draftCtx, sizeMap, {}, true);
        });
        hideDialog();
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>{isRow ? 'Row height' : 'Column width'}</DialogTitle>
            </DialogHeader>
            <div className="py-4">
                <div className="flex items-center gap-2">
                    <Input
                        ref={inputRef}
                        type="number"
                        min={1}
                        max={MAX_SIZE[mode]}
                        value={value}
                        className="w-24"
                        aria-label={isRow ? 'Row height in pixels' : 'Column width in pixels'}
                        onChange={(e) => setValue(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') apply();
                        }}
                    />
                    <span className="text-sm text-muted-foreground">px</span>
                </div>
                {value !== '' && !isValid && (
                    <p className="mt-1.5 text-sm text-destructive">{`Enter a value between 1 and ${MAX_SIZE[mode]}.`}</p>
                )}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    Cancel
                </Button>
                <Button size="sm" disabled={!isValid} onClick={apply}>
                    OK
                </Button>
            </DialogFooter>
        </>
    );
}
