import {useCallback, useContext, useMemo, useState} from "react";
import {cancelNormalSelected, getSheetIndex, locale, update,} from "../../core";
import {Button} from "@workspace/ui/components/button";
import {Input} from "@workspace/ui/components/input";
import {Label} from "@workspace/ui/components/label";
import {DialogFooter, DialogHeader, DialogTitle} from "@workspace/ui/components/dialog";
import {cn} from "@workspace/ui/lib/utils";
import {WorkbookContext} from "../../context";
import {useDialog} from "../../hooks/useDialog";

export function FormatSearch({
                                 type,
                                 onCancel: _onCancel,
                             }: {
    type: "currency" | "date" | "number";
    onCancel: () => void;
}) {
    const {
        context,
        setContext,
        refs: {cellInput},
    } = useContext(WorkbookContext);
    const [decimalPlace, setDecimalPlace] = useState(2);
    const [selectedFormatIndex, setSelectedFormatIndex] = useState(0);
    const {button, format, currencyDetail, dateFmtList, numberFmtList} =
        locale(context);
    const {showDialog} = useDialog();
    const toolbarFormatAll = useMemo(
        () => ({
            currency: currencyDetail,
            date: dateFmtList,
            number: numberFmtList,
        }),
        [currencyDetail, dateFmtList, numberFmtList]
    );

    type ToolbarFormatType = { name: string; pos?: string; value: string };

    const toolbarFormat: ToolbarFormatType[] = useMemo(
        () => toolbarFormatAll[type],
        [toolbarFormatAll, type]
    );

    const title = type === "currency" ? format.titleCurrency : format.titleNumber;

    const onConfirm = useCallback(() => {
        if (decimalPlace < 0 || decimalPlace > 9) {
            _onCancel();
            showDialog(format.tipDecimalPlaces, "ok");
            return;
        }
        setContext((ctx) => {
            const index = getSheetIndex(ctx, ctx.currentSheetId);
            if (index == null) return;
            const selectedFormatVal = toolbarFormat[selectedFormatIndex].value;

            let selectedFormatPos: string;
            if ("pos" in toolbarFormat[selectedFormatIndex])
                selectedFormatPos = toolbarFormat[selectedFormatIndex].pos || "before";

            for (const selection of ctx.luckysheet_select_save ?? []) {
                for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
                    for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
                        if (
                            ctx.luckysheetfile[index].data?.[r][c] &&
                            ctx.luckysheetfile[index].data?.[r][c]?.ct?.t === "n"
                        ) {
                            const zero = 0;
                            if (selectedFormatPos! === "after") {
                                ctx.luckysheetfile[index].data![r][c]!.ct!.fa = zero
                                    .toFixed(decimalPlace)
                                    .concat(`${selectedFormatVal}`);
                                ctx.luckysheetfile[index].data![r][c]!.m = update(
                                    zero.toFixed(decimalPlace).concat(`${selectedFormatVal}`),
                                    ctx.luckysheetfile[index].data![r][c]!.v
                                );
                            } else {
                                ctx.luckysheetfile[index].data![r][c]!.ct!.fa =
                                    `${selectedFormatVal}`.concat(zero.toFixed(decimalPlace));
                                ctx.luckysheetfile[index].data![r][c]!.m = update(
                                    `${selectedFormatVal}`.concat(zero.toFixed(decimalPlace)),
                                    ctx.luckysheetfile[index].data![r][c]!.v
                                );
                            }
                        }
                    }
                }
            }
            _onCancel();
        });
    }, [
        _onCancel,
        decimalPlace,
        format.tipDecimalPlaces,
        selectedFormatIndex,
        setContext,
        showDialog,
        toolbarFormat,
    ]);

    const onCancel = useCallback(() => {
        setContext((ctx) => {
            cancelNormalSelected(ctx);
            if (cellInput.current) {
                cellInput.current.textContent = "";
            }
        });
        _onCancel();
    }, [_onCancel, cellInput, setContext]);

    return (
        <div className="flex flex-col min-h-0 flex-1 p-6 gap-4">
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            <div className="flex items-center gap-2 shrink-0">
                <Label className="text-sm whitespace-nowrap">{format.decimalPlaces}:</Label>
                <Input
                    type="number"
                    min={0}
                    max={9}
                    defaultValue={2}
                    className="w-20 h-8"
                    onChange={(e) => setDecimalPlace(parseInt(e.target.value, 10))}
                />
            </div>
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {toolbarFormat.map((v: ToolbarFormatType, index: number) => (
                    <div
                        className={cn(
                            "flex items-center justify-between px-3 py-1.5 text-sm cursor-pointer border-b border-border",
                            index === selectedFormatIndex
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted/50"
                        )}
                        key={v.name}
                        onClick={() => setSelectedFormatIndex(index)}
                        tabIndex={0}
                    >
                        <span>{v.name}</span>
                        <span
                            className={index === selectedFormatIndex ? "text-primary-foreground/70" : "text-muted-foreground"}>{v.value}</span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
                <Button size="sm" onClick={onConfirm}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}
