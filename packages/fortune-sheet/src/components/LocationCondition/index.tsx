import {applyLocation, getFlowdata, getOptionValue, getSelectRange, locale,} from "../../core";
import produce from "immer";
import {useCallback, useContext, useState} from "react";
import {WorkbookContext} from "../../context";
import {useDialog} from "../../hooks/useDialog";
import {Button} from "@workspace/ui/components/button";

export function LocationCondition() {
    const {context, setContext} = useContext(WorkbookContext);
    const {showDialog, hideDialog} = useDialog();
    const {findAndReplace, button} = locale(context);
    const [conditionType, setConditionType] = useState("locationConstant");
    const [constants, setConstants] = useState<Record<string, boolean>>({
        locationDate: true,
        locationDigital: true,
        locationString: true,
        locationBool: true,
        locationError: true,
    });
    const [formulas, setFormulas] = useState<Record<string, boolean>>({
        locationDate: true,
        locationDigital: true,
        locationString: true,
        locationBool: true,
        locationError: true,
    });
    // Confirm button
    const onConfirm = useCallback(() => {
        if (conditionType === "locationConstant") {
            const value = getOptionValue(constants);
            const selectRange = getSelectRange(context);
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, value, ctx);
                if (rangeArr.length === 0)
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
            });
        } else if (conditionType === "locationFormula") {
            const value = getOptionValue(formulas);
            const selectRange = getSelectRange(context);
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, value, ctx);
                if (rangeArr.length === 0)
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
            });
        } else if (conditionType === "locationRowSpan") {
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].row[0] ===
                    context.luckysheet_select_save[0].row[1])
            ) {
                showDialog(findAndReplace.locationTiplessTwoRow, "ok");
                return;
            }
            const selectRange = [...(context.luckysheet_select_save ?? [])];
            setContext((ctx) => {
                const rangeArr = applyLocation(
                    selectRange,
                    conditionType,
                    undefined,
                    ctx
                );
                if (rangeArr.length === 0)
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
            });
        } else if (conditionType === "locationColumnSpan") {
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].column[0] ===
                    context.luckysheet_select_save[0].column[1])
            ) {
                showDialog(findAndReplace.locationTiplessTwoColumn, "ok");
                return;
            }
            const selectRange = [...(context.luckysheet_select_save ?? [])];
            setContext((ctx) => {
                const rangeArr = applyLocation(
                    selectRange,
                    conditionType,
                    undefined,
                    ctx
                );
                if (rangeArr.length === 0)
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
            });
        } else {
            // Empty value handling
            let selectRange: {
                row: (number | undefined)[];
                column: any[];
            }[];
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].row[0] ===
                    context.luckysheet_select_save[0].row[1] &&
                    context.luckysheet_select_save[0].column[0] ===
                    context.luckysheet_select_save[0].column[1])
            ) {
                const flowdata = getFlowdata(context, context.currentSheetId);
                selectRange = [
                    {
                        row: [0, flowdata!.length - 1],
                        column: [0, flowdata![0].length - 1],
                    },
                ];
            } else {
                selectRange = [...(context.luckysheet_select_save ?? [])];
            }
            setContext((ctx) => {
                const rangeArr = applyLocation(
                    selectRange,
                    conditionType,
                    undefined,
                    ctx
                );
                if (rangeArr.length === 0)
                    showDialog(findAndReplace.locationTipNotFindCell, "ok");
            });
        }
    }, [
        conditionType,
        constants,
        context,
        findAndReplace.locationTipNotFindCell,
        findAndReplace.locationTiplessTwoColumn,
        findAndReplace.locationTiplessTwoRow,
        formulas,
        setContext,
        showDialog,
    ]);

    // Selection event handler
    const isSelect = useCallback(
        (currentType: string) => conditionType === currentType,
        [conditionType]
    );

    return (
        <div className="min-w-[500px]">
            <div className="text-base leading-[48px]">{findAndReplace.location}</div>
            <div className="border border-[#dfdfdf] p-2.5 text-sm">
                {/* Constants */}
                <div className="py-1.5">
                    <input
                        type="radio"
                        name="locationType"
                        id="locationConstant"
                        checked={isSelect("locationConstant")}
                        onChange={() => {
                            setConditionType("locationConstant");
                        }}
                    />
                    <label htmlFor="locationConstant">
                        {findAndReplace.locationConstant}
                    </label>
                    <div className="h-[30px] px-2.5 flex gap-1">
                        {[
                            "locationDate",
                            "locationDigital",
                            "locationString",
                            "locationBool",
                            "locationError",
                        ].map((v) => (
                            <div className="float-left mr-1.5" key={v}>
                                <input
                                    type="checkbox"
                                    disabled={!isSelect("locationConstant")}
                                    checked={constants[v]}
                                    onChange={() => {
                                        setConstants(
                                            produce((draft) => {
                                                draft[v] = !draft[v];
                                            })
                                        );
                                    }}
                                />
                                <label
                                    htmlFor={v}
                                    style={{
                                        color: isSelect("locationConstant") ? "#000" : "#666",
                                    }}
                                >
                                    {(findAndReplace as any)[v]}
                                </label>
                            </div>
                        ))}
                    </div>
                </div>
                {/* Formula */}
                <div className="py-1.5">
                    <input
                        type="radio"
                        name="locationType"
                        id="locationFormula"
                        checked={isSelect("locationFormula")}
                        onChange={() => {
                            setConditionType("locationFormula");
                        }}
                    />
                    <label htmlFor="locationFormula">
                        {findAndReplace.locationFormula}
                    </label>
                    <div className="h-[30px] px-2.5 flex gap-1">
                        {[
                            "locationDate",
                            "locationDigital",
                            "locationString",
                            "locationBool",
                            "locationError",
                        ].map((v) => (
                            <div className="float-left mr-1.5" key={v}>
                                <input
                                    type="checkbox"
                                    disabled={!isSelect("locationFormula")}
                                    checked={formulas[v]}
                                    onChange={() => {
                                        setFormulas(
                                            produce((draft) => {
                                                draft[v] = !draft[v];
                                            })
                                        );
                                    }}
                                />
                                <label
                                    htmlFor={v}
                                    style={{
                                        color: isSelect("locationFormula") ? "#000" : "#666",
                                    }}
                                >
                                    {(findAndReplace as any)[v]}
                                </label>
                            </div>
                        ))}
                    </div>
                </div>
                {/* TODO Conditional format */}
                {["locationNull", "locationRowSpan", "locationColumnSpan"].map((v) => (
                    <div className="py-1.5" key={v}>
                        <input
                            type="radio"
                            name={v}
                            checked={isSelect(v)}
                            onChange={() => {
                                setConditionType(v);
                            }}
                        />
                        <label htmlFor={v}>{(findAndReplace as any)[v]}</label>
                    </div>
                ))}
            </div>

            <div className="flex gap-2 mt-3">
                <Button size="sm" onClick={() => {
                    hideDialog();
                    onConfirm();
                }}>
                    {button.confirm}
                </Button>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
            </div>
        </div>
    );
}
