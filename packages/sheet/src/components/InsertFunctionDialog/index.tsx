// The Insert function dialog of the spreadsheet, opened from the Insert menu: a search and a category dropdown over the
// list of functions, with one highlighted. OK opens the in-cell editor on the focus cell with that function's name and
// an open bracket, so the user types its arguments next.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import { FUNCTION_LIST, setCaretPosition } from '../../state';

// The categories of the dropdown. Their ids are FUNCTION_LIST's `t`.
export const FUNCTION_CATEGORIES = [
    { t: 0, n: 'Math' },
    { t: 1, n: 'Statistical' },
    { t: 2, n: 'Lookup' },
    { t: 4, n: 'Data mining' },
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

export function InsertFunctionDialog() {
    const {
        setContext,
        refs: { cellInput, globalCache },
    } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const [category, setCategory] = useState(0);
    const [highlight, setHighlight] = useState(0);
    const [searchText, setSearchText] = useState('');

    const functions = useMemo(() => {
        if (searchText) {
            const text = searchText.toUpperCase();
            const isAlpha = /^[a-zA-Z]+$/.test(text);
            return FUNCTION_LIST.filter((fn) => (isAlpha ? fn.n.includes(text) : fn.a.includes(text)));
        }
        return FUNCTION_LIST.filter((fn) => fn.t === category);
    }, [category, searchText]);

    // The caret goes after the bracket, and the function's hint shows. An edit already open in the cell is replaced.
    const insert = () => {
        const name = functions[highlight].n;
        setContext((ctx) => {
            const input = cellInput.current;
            if (!input) return;
            const last = ctx.selections?.at(-1);
            ctx.editingCellPosition = [
                last?.row_focus ?? last?.row[0] ?? 0,
                last?.column_focus ?? last?.column[0] ?? 0,
            ];
            globalCache.doNotUpdateCell = true;
            input.innerHTML = `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${name}</span><span dir="auto" class="sheet-formula-text-color">(</span>`;
            const bracket = input.lastElementChild;
            if (bracket instanceof HTMLElement) setCaretPosition(ctx, bracket, 0, 1);
            ctx.functionHint = name;
            ctx.functionCandidates = [];
            if (Object.keys(ctx.formulaCache.functionlistMap).length === 0) {
                for (const fn of FUNCTION_LIST) {
                    ctx.formulaCache.functionlistMap[fn.n] = fn;
                }
            }
        });
    };

    return (
        <FormDialog {...dialogProps} title="Select a function" size="md">
            <FormDialogForm submitLabel="OK" canSubmit={functions.length > 0} onSubmit={insert}>
                <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
                    <div className="space-y-1.5">
                        <Label htmlFor="searchFormulaListInput">Search function</Label>
                        <Input
                            id="searchFormulaListInput"
                            placeholder="Function name or brief description of function"
                            spellCheck={false}
                            onChange={(e) => {
                                setSearchText(e.target.value);
                                setHighlight(0);
                            }}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="insertFunctionCategory">Or select a category</Label>
                        <Select
                            value={String(category)}
                            onValueChange={(value) => {
                                setCategory(parseInt(value, 10));
                                setHighlight(0);
                            }}
                        >
                            <SelectTrigger id="insertFunctionCategory" className="w-[160px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {FUNCTION_CATEGORIES.map(({ t, n }) => (
                                    <SelectItem key={t} value={String(t)}>
                                        {n}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <div className="max-h-[40vh] border border-border rounded-md overflow-y-auto">
                    {functions.map((fn, index) => (
                        <button
                            type="button"
                            className={cn(
                                'block w-full text-left px-3 py-2 border-b border-border text-sm eigen-list-item',
                                index === highlight && 'eigen-list-item-active',
                            )}
                            key={fn.n}
                            onClick={() => setHighlight(index)}
                        >
                            <div className="font-medium">{fn.n}</div>
                            <div className="text-xs text-muted-foreground">{fn.a}</div>
                        </button>
                    ))}
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}
