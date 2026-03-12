/* eslint-disable jsx-a11y/control-has-associated-label */
import {getDataArr, getFlowdata, getRegStr, locale, updateMoreCell,} from "../../core";
import {useCallback, useContext, useEffect, useRef, useState,} from "react";
import WorkbookContext from "../../context";
import {useDialog} from "../../hooks/useDialog";
import {Button} from "@workspace/ui/components/button";

export function SplitColumn() {
    const {context, setContext} = useContext(WorkbookContext);
    const {splitText, button} = locale(context);
    const [splitOperate, setSplitOperate] = useState("");
    const [otherFlag, setOtherFlag] = useState(false);
    const [tableData, setTableData] = useState<string[][]>([]);
    const splitSymbols = useRef<HTMLDivElement>(null);
    const {showDialog, hideDialog} = useDialog();

    // Confirm button
    const certainBtn = useCallback(() => {
        hideDialog();
        const dataArr = getDataArr(splitOperate, context);
        const r = context.luckysheet_select_save![0].row[0];
        const c = context.luckysheet_select_save![0].column[0];
        if (dataArr[0].length === 1) {
            return;
        }
        let dataCover = false;
        const data = getFlowdata(context);
        for (let i = 0; i < dataArr.length; i += 1) {
            for (let j = 1; j < dataArr[0].length; j += 1) {
                const cell = data![r + i][c + j];
                if (cell != null && cell.v != null) {
                    dataCover = true;
                    break;
                }
            }
        }
        if (dataCover) {
            showDialog(splitText.splitConfirmToExe, "yesno", () => {
                hideDialog();
                setContext((ctx) => {
                    updateMoreCell(r, c, dataArr, ctx);
                });
            });
        } else {
            setContext((ctx) => {
                updateMoreCell(r, c, dataArr, ctx);
            });
        }
    }, [
        context,
        hideDialog,
        setContext,
        showDialog,
        splitOperate,
        splitText.splitConfirmToExe,
    ]);

    // Data preview
    useEffect(() => {
        setTableData((table) => {
            table = getDataArr(splitOperate, context);
            return table;
        });
    }, [context, splitOperate]);

    return (
        <div className="min-w-[500px] select-none [&_table]:border-collapse [&_td]:border [&_td]:border-[#333]">
            <div className="text-base">{splitText.splitTextTitle}</div>
            <div className="mt-2.5">{splitText.splitDelimiters}</div>
            <div className="relative border border-[#dfdfdf] p-1.5 my-1.5" ref={splitSymbols}>
                {splitText.splitSymbols.map((o) => (
                    <div key={o.value} className="text-sm">
                        <input
                            id={o.value}
                            name={o.value}
                            type="checkbox"
                            onClick={() =>
                                setSplitOperate((regStr) => {
                                    return getRegStr(regStr, splitSymbols.current?.childNodes);
                                })
                            }
                            tabIndex={0}
                        />
                        <label htmlFor={o.value}>{o.name}</label>
                    </div>
                ))}
                <div className="text-sm">
                    <input
                        id="other"
                        name="other"
                        type="checkbox"
                        onClick={() => {
                            setOtherFlag(!otherFlag);
                            setSplitOperate((regStr) => {
                                return getRegStr(regStr, splitSymbols.current?.childNodes);
                            });
                        }}
                        tabIndex={0}
                    />
                    <label htmlFor="other">{splitText.splitOther}</label>
                    <input
                        id="otherValue"
                        name="otherValue"
                        className="ml-1.5 w-[50px] px-1.5"
                        type="text"
                        onBlur={() => {
                            if (otherFlag) {
                                setSplitOperate((regStr) => {
                                    return getRegStr(regStr, splitSymbols.current?.childNodes);
                                });
                            }
                        }}
                    />
                </div>
                <div className="text-sm absolute top-[114px] left-0">
                    <input
                        id="splitsimple"
                        name="splitsimple"
                        type="checkbox"
                        onClick={() => {
                            setSplitOperate((regStr) => {
                                return getRegStr(regStr, splitSymbols.current?.childNodes);
                            });
                        }}
                        tabIndex={0}
                    />
                    <label htmlFor="splitsimple">{splitText.splitContinueSymbol}</label>
                </div>
            </div>
            <div className="text-sm mt-6">{splitText.splitDataPreview}</div>
            <div className="border border-[#dfdfdf] p-1.5 my-1.5 h-[100px] overflow-y-auto">
                <table>
                    <tbody>
                    {tableData.map((o, index) => {
                        if (o.length >= 1) {
                            return (
                                <tr key={index}>
                                    {o.map((o1: string) => (
                                        <td key={o + o1}>{o1}</td>
                                    ))}
                                </tr>
                            );
                        }
                        return (
                            <tr>
                                <td/>
                            </tr>
                        );
                    })}
                    </tbody>
                </table>
            </div>
            <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={() => certainBtn()}>
                    {button.confirm}
                </Button>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
            </div>
        </div>
    );
}
