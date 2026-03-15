import {useCallback, useContext, useMemo, useState} from "react";
import {cancelNormalSelected, locale, setCaretPosition,} from "../../core";
import {WorkbookContext} from "../../context";
import {Button} from "@workspace/ui/components/button";
import {DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {Input} from "@workspace/ui/components/input";
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from "@workspace/ui/components/select";
import {Label} from "@workspace/ui/components/label";

export function FormulaSearch({
                                  onCancel: _onCancel,
                              }: { onCancel: () => void }) {
    const {
        context,
        setContext,
        refs: {cellInput, globalCache},
    } = useContext(WorkbookContext);
    const [selectedType, setSelectedType] = useState(0);
    const [selectedFuncIndex, setSelectedFuncIndex] = useState(0);
    const [searchText, setSearchText] = useState("");
    const {formulaMore, functionlist, button} = locale(context);

    const typeList = useMemo(
        () => [
            {t: 0, n: formulaMore.Math},
            {t: 1, n: formulaMore.Statistical},
            {t: 2, n: formulaMore.Lookup},
            {t: 3, n: formulaMore.luckysheet},
            {t: 4, n: formulaMore.dataMining},
            {t: 5, n: formulaMore.Database},
            {t: 6, n: formulaMore.Date},
            {t: 7, n: formulaMore.Filter},
            {t: 8, n: formulaMore.Financial},
            {t: 9, n: formulaMore.Engineering},
            {t: 10, n: formulaMore.Logical},
            {t: 11, n: formulaMore.Operator},
            {t: 12, n: formulaMore.Text},
            {t: 13, n: formulaMore.Parser},
            {t: 14, n: formulaMore.Array},
            {t: -1, n: formulaMore.other},
        ],
        [formulaMore]
    );

    const filteredFunctionList = useMemo(() => {
        if (searchText) {
            const text = searchText.toUpperCase();
            const isAlpha = /^[a-zA-Z]+$/.test(text);
            return functionlist.filter((fn) =>
                isAlpha ? fn.n.includes(text) : fn.a.includes(text)
            );
        }
        return functionlist.filter((v) => v.t === selectedType);
    }, [functionlist, selectedType, searchText]);

    const onConfirm = useCallback(() => {
        const last =
            context.luckysheet_select_save?.[
            context.luckysheet_select_save.length - 1
                ];
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
        const formulaTxt = `<span dir="auto" class="luckysheet-formula-text-color">=</span><span dir="auto" class="luckysheet-formula-text-color">${filteredFunctionList[
            selectedFuncIndex
            ].n.toUpperCase()}</span><span dir="auto" class="luckysheet-formula-text-color">(</span>`;
        setContext((ctx) => {
            if (cellInput.current != null) {
                ctx.luckysheetCellUpdate = [row_index, col_index];
                globalCache.doNotUpdateCell = true;
                cellInput.current.innerHTML = formulaTxt;
                const spans = cellInput.current.childNodes;
                if (spans.length > 0) {
                    setCaretPosition(
                        ctx,
                        spans[spans.length - 1] as HTMLSpanElement,
                        0,
                        1
                    );
                }
                ctx.functionHint =
                    filteredFunctionList[selectedFuncIndex].n.toUpperCase();
                ctx.functionCandidates = [];
                if (Object.keys(ctx.formulaCache.functionlistMap).length === 0) {
                    for (const fn of functionlist) {
                        ctx.formulaCache.functionlistMap[fn.n] = fn;
                    }
                }
                _onCancel();
            }
        });
    }, [
        cellInput,
        context.luckysheet_select_save,
        filteredFunctionList,
        globalCache,
        selectedFuncIndex,
        setContext,
        _onCancel,
        functionlist,
    ]);

    const onCancel = useCallback(() => {
        setContext((ctx) => {
            cancelNormalSelected(ctx);
            if (cellInput.current) {
                cellInput.current.innerHTML = "";
            }
        });
        _onCancel();
    }, [_onCancel, cellInput, setContext]);

    return (
        <div className="flex flex-col min-h-0 flex-1 p-6 gap-4">
            <DialogHeader>
                <DialogTitle>{formulaMore.selectFunctionTitle}</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-[1fr_auto] gap-3 shrink-0 items-end">
                <div className="space-y-1.5">
                    <Label htmlFor="searchFormulaListInput">{formulaMore.findFunctionTitle}</Label>
                    <Input
                        id="searchFormulaListInput"
                        placeholder={formulaMore.tipInputFunctionName}
                        spellCheck={false}
                        onChange={(e) => setSearchText(e.target.value)}
                    />
                </div>
                <div className="space-y-1.5">
                    <Label>{formulaMore.selectCategory}</Label>
                    <Select
                        value={String(selectedType)}
                        onValueChange={(v) => {
                            setSelectedType(parseInt(v, 10));
                            setSelectedFuncIndex(0);
                        }}
                    >
                        <SelectTrigger className="w-[160px]">
                            <SelectValue/>
                        </SelectTrigger>
                        <SelectContent>
                            {typeList.map((v) => (
                                <SelectItem key={v.t} value={String(v.t)}>{v.n}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {filteredFunctionList.map((v, index) => (
                    <div
                        className={`px-3 py-2 cursor-pointer border-b border-border text-sm ${index === selectedFuncIndex ? "bg-primary text-primary-foreground" : "hover:bg-muted/50"}`}
                        key={v.n}
                        onClick={() => setSelectedFuncIndex(index)}
                        tabIndex={0}
                    >
                        <div className="font-medium">{v.n}</div>
                        <div className={`text-xs ${index === selectedFuncIndex ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{v.a}</div>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
                <Button size="sm" onClick={onConfirm} disabled={filteredFunctionList.length === 0}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}
