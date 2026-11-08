// The Insert function dialog of the spreadsheet, opened from the Insert menu: a search and a category dropdown over the
// list of functions, with one highlighted. OK opens the in-cell editor on the focus cell with that function's name and
// an open bracket, so the user types its arguments next.

import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useScrollToIndex } from '@workspace/ui/hooks/use-scroll-to-index';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useMemo, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialogProps } from '../../hooks/useDialog';
import type { FormulaFunctionEntry } from '../../state';
import { FUNCTION_CATEGORIES, FUNCTION_LIST, openCellEditor } from '../../state';

// Each function with its name and description in lower case, so a search ignores case without lowering them per key.
const SEARCHABLE_FUNCTIONS = FUNCTION_LIST.map((fn) => ({
    fn,
    name: fn.n.toLowerCase(),
    description: fn.a.toLowerCase(),
}));

export function InsertFunctionDialog() {
    const { setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const [category, setCategory] = useState(0);
    const [highlight, setHighlight] = useState(0);
    const [searchText, setSearchText] = useState('');
    const listRef = useRef<HTMLDivElement>(null);
    useScrollToIndex(listRef, highlight);

    const functions = useMemo(() => {
        const text = searchText.trim().toLowerCase();
        if (!text) return FUNCTION_LIST.filter((fn) => fn.t === category);
        // The typed name comes first, then the names that start with it, the other names that hold it and the
        // descriptions that do, so Enter after a typed name inserts that function.
        const ranked: { fn: FormulaFunctionEntry; rank: number }[] = [];
        for (const { fn, name, description } of SEARCHABLE_FUNCTIONS) {
            if (name === text) ranked.push({ fn, rank: 0 });
            else if (name.startsWith(text)) ranked.push({ fn, rank: 1 });
            else if (name.includes(text)) ranked.push({ fn, rank: 2 });
            else if (description.includes(text)) ranked.push({ fn, rank: 3 });
        }
        return ranked.sort((a, b) => a.rank - b.rank).map(({ fn }) => fn);
    }, [category, searchText]);

    // The caret goes after the bracket, and the function's hint shows. An edit already open in the cell is replaced.
    const insert = () => {
        const name = functions[highlight].n;
        setContext((ctx) => {
            const last = ctx.selections?.at(-1);
            const r = last?.row_focus ?? last?.row[0] ?? 0;
            const c = last?.column_focus ?? last?.column[0] ?? 0;
            const html = `<span dir="auto" class="sheet-formula-text-color">=</span><span dir="auto" class="sheet-formula-text-color">${name}</span><span dir="auto" class="sheet-formula-text-color">(</span>`;
            openCellEditor(ctx, r, c, { html, caret: name.length + 2 });
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
                        <Label htmlFor="search-function">Search function</Label>
                        <Input
                            id="search-function"
                            placeholder="Function name or brief description of function"
                            spellCheck={false}
                            onChange={(e) => {
                                setSearchText(e.target.value);
                                setHighlight(0);
                            }}
                            // Up and Down move the highlight through the list, and the caret stays where it is.
                            onKeyDown={(e) => {
                                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                                e.preventDefault();
                                const step = e.key === 'ArrowDown' ? 1 : -1;
                                setHighlight((i) => Math.max(0, Math.min(i + step, functions.length - 1)));
                            }}
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="function-category">Or select a category</Label>
                        <Select
                            value={String(category)}
                            onValueChange={(value) => {
                                setCategory(parseInt(value, 10));
                                setHighlight(0);
                            }}
                        >
                            <SelectTrigger id="function-category" className="w-[160px]">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {FUNCTION_CATEGORIES.map(({ id, name }) => (
                                    <SelectItem key={id} value={String(id)}>
                                        {name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </div>
                <div ref={listRef} className="max-h-[40vh] border border-border rounded-md overflow-y-auto">
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
