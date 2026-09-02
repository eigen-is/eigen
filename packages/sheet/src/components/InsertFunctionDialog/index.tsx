import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { cancelNormalSelected, FUNCTION_LIST, setCaretPosition } from '../../state';

// Function-category tabs. The ids are FUNCTION_LIST's `t`; pinned against it by
// test/state/modules/function-list.test.ts.
export const FUNCTION_CATEGORIES = [
    { t: 0, n: 'Math' },
    { t: 1, n: 'Statistical' },
    { t: 2, n: 'Lookup' },
    { t: 4, n: 'Data Mining' },
    { t: 5, n: 'Database' },
    { t: 6, n: 'Date' },
    { t: 7, n: 'Filter' },
    { t: 8, n: 'Financial' },
    { t: 9, n: 'Engineering' },
    { t: 10, n: 'Logical' },
    { t: 11, n: 'Operator' },
    { t: 12, n: 'Text' },
    { t: 13, n: 'Parser' },
    { t: 14, n: 'Array' },
    { t: -1, n: 'Other' },
];

export function InsertFunctionDialog({ onCancel: _onCancel }: { onCancel: () => void }) {
    const {
        context,
        setContext,
        refs: { cellInput, globalCache },
    } = useContext(WorkbookContext);
    const [selectedType, setSelectedType] = useState(0);
    const [selectedFuncIndex, setSelectedFuncIndex] = useState(0);
    const [searchText, setSearchText] = useState('');

    const filteredFunctionList = useMemo(() => {
        if (searchText) {
            const text = searchText.toUpperCase();
            const isAlpha = /^[a-zA-Z]+$/.test(text);
            return FUNCTION_LIST.filter((fn) => (isAlpha ? fn.n.includes(text) : fn.a.includes(text)));
        }
        return FUNCTION_LIST.filter((v) => v.t === selectedType);
    }, [selectedType, searchText]);

    const onConfirm = useCallback(() => {
        const last = context.selections?.[context.selections.length - 1];
        let row_index = last?.row_focus;
        let col_index = last?.column_focus;
        if (!last) {
            row_index = 0;
            col_index = 0;
        } else {
            if (row_index == null) {
                [row_index] = last.row;
            }
            if (col_index == null) {
                [col_index] = last.column;
            }
        }
        const formulaTxt = `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${filteredFunctionList[
            selectedFuncIndex
        ].n.toUpperCase()}</span><span dir="auto" class="sheet-formula-text-color">(</span>`;
        setContext((ctx) => {
            if (cellInput.current != null) {
                ctx.editingCellPosition = [row_index, col_index];
                globalCache.doNotUpdateCell = true;
                cellInput.current.innerHTML = formulaTxt;
                const spans = cellInput.current.childNodes;
                if (spans.length > 0) {
                    setCaretPosition(ctx, spans[spans.length - 1] as HTMLSpanElement, 0, 1);
                }
                ctx.functionHint = filteredFunctionList[selectedFuncIndex].n.toUpperCase();
                ctx.functionCandidates = [];
                if (Object.keys(ctx.formulaCache.functionlistMap).length === 0) {
                    for (const fn of FUNCTION_LIST) {
                        ctx.formulaCache.functionlistMap[fn.n] = fn;
                    }
                }
                _onCancel();
            }
        });
    }, [cellInput, context.selections, filteredFunctionList, globalCache, selectedFuncIndex, setContext, _onCancel]);

    const onCancel = useCallback(() => {
        setContext((ctx) => {
            cancelNormalSelected(ctx);
            if (cellInput.current) {
                cellInput.current.innerHTML = '';
            }
        });
        _onCancel();
    }, [_onCancel, cellInput, setContext]);

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>Select a function</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-[1fr_auto] gap-3 shrink-0 items-end">
                <div className="space-y-1.5">
                    <Label htmlFor="searchFormulaListInput">Search function</Label>
                    <Input
                        id="searchFormulaListInput"
                        placeholder="Function name or brief description of function"
                        spellCheck={false}
                        onChange={(e) => {
                            setSearchText(e.target.value);
                            setSelectedFuncIndex(0);
                        }}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>Or select a category</Label>
                    <Select
                        value={String(selectedType)}
                        onValueChange={(v) => {
                            setSelectedType(parseInt(v, 10));
                            setSelectedFuncIndex(0);
                        }}
                    >
                        <SelectTrigger className="w-[160px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {FUNCTION_CATEGORIES.map((v) => (
                                <SelectItem key={v.t} value={String(v.t)}>
                                    {v.n}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {filteredFunctionList.map((v, index) => (
                    <button
                        type="button"
                        className={cn(
                            'block w-full text-left px-3 py-2 border-b border-border text-sm eigen-list-item',
                            index === selectedFuncIndex && 'eigen-list-item-active',
                        )}
                        key={v.n}
                        onClick={() => setSelectedFuncIndex(index)}
                    >
                        <div className="font-medium">{v.n}</div>
                        <div className="text-xs text-muted-foreground">{v.a}</div>
                    </button>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
                <Button size="sm" onClick={onConfirm} disabled={filteredFunctionList.length === 0}>
                    OK
                </Button>
            </DialogFooter>
        </div>
    );
}
