import React, {useCallback, useContext, useMemo, useState} from "react";
import {cancelNormalSelected, locale, setCaretPosition,} from "../../core";
import _ from "lodash";
import WorkbookContext from "../../context";
import {Button} from "@workspace/ui/components/button";

export const FormulaSearch: React.FC<{ onCancel: () => void }> = ({
                                                                      onCancel: _onCancel,
                                                                  }) => {
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
            const list = [];
            const text = _.cloneDeep(searchText.toUpperCase());
            for (let i = 0; i < functionlist.length; i += 1) {
                if (/^[a-zA-Z]+$/.test(text)) {
                    if (functionlist[i].n.indexOf(text) !== -1) {
                        list.push(functionlist[i]);
                    }
                } else if (functionlist[i].a.indexOf(text) !== -1) {
                    list.push(functionlist[i]);
                }
            }
            return list;
        }
        return _.filter(functionlist, (v) => v.t === selectedType);
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
                if (!_.isEmpty(spans)) {
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
                if (_.isEmpty(ctx.formulaCache.functionlistMap)) {
                    for (let i = 0; i < functionlist.length; i += 1) {
                        ctx.formulaCache.functionlistMap[functionlist[i].n] =
                            functionlist[i];
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
        <div id="luckysheet-search-formula" className="text-xs">
            <div className="mb-1.5 [&>div]:block [&>div]:mb-1.5">
                <div>{formulaMore.findFunctionTitle}：</div>
                <input
                    className="w-full h-6 leading-6 border border-border px-2.5 text-xs box-border"
                    id="searchFormulaListInput"
                    placeholder={formulaMore.tipInputFunctionName}
                    spellCheck="false"
                    onChange={(e) => setSearchText(e.target.value)}
                />
            </div>
            <div className="mb-1.5">
                <span>{formulaMore.selectCategory}：</span>
                <select
                    id="formulaTypeSelect"
                    onChange={(e) => {
                        setSelectedType(parseInt(e.target.value, 10));
                        setSelectedFuncIndex(0);
                    }}
                >
                    {typeList.map((v) => (
                        <option key={v.t} value={v.t}>
                            {v.n}
                        </option>
                    ))}
                </select>
            </div>
            <div className="[&>label]:block [&>label]:mb-1.5" style={{height: 200}}>
                <div>{formulaMore.selectFunctionTitle}：</div>
                <div className="w-[300px] h-[170px] border border-border overflow-y-auto">
                    {filteredFunctionList.map((v, index) => (
                        <div
                            className={`p-1.5 border-b border-border cursor-pointer ${index === selectedFuncIndex ? "bg-primary text-primary-foreground" : ""}`}
                            key={v.n}
                            onClick={() => setSelectedFuncIndex(index)}
                            tabIndex={0}
                        >
                            <div>{v.n}</div>
                            <div>{v.a}</div>
                        </div>
                    ))}
                </div>
            </div>
            <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={onConfirm}>
                    {button.confirm}
                </Button>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
            </div>
        </div>
    );
};
