import {getRangetxt, locale} from "../../core";

import React, {useCallback, useContext, useEffect, useState} from "react";
import DataVerification from ".";
import WorkbookContext from "../../context";
import {useDialog} from "../../hooks/useDialog";
import ConditionRules from "../ConditionFormat/ConditionRules";
import {Button} from "@workspace/ui/components/button";

const RangeDialog: React.FC = () => {
    const {context, setContext} = useContext(WorkbookContext);
    const {showDialog} = useDialog();
    const {dataVerification, button} = locale(context);
    const [rangeTxt2, setRangeTxt2] = useState<string>(
        context.rangeDialog?.rangeTxt ?? ""
    );

    const close = useCallback(() => {
        setContext((ctx) => {
            ctx.rangeDialog!.show = false;
            ctx.rangeDialog!.singleSelect = false;
        });
        if (!context.rangeDialog) return;
        const rangeDialogType = context.rangeDialog.type;
        if (rangeDialogType.indexOf("between") >= 0) {
            showDialog(<ConditionRules type="between"/>);
            return;
        }
        if (rangeDialogType.indexOf("conditionRules") >= 0) {
            const rulesType = rangeDialogType.substring(
                "conditionRules".length,
                rangeDialogType.length
            );
            showDialog(<ConditionRules type={rulesType}/>);
            return;
        }
        showDialog(<DataVerification/>);
    }, [context.rangeDialog, setContext, showDialog]);

    useEffect(() => {
        setRangeTxt2((r) => {
            if (context.luckysheet_select_save) {
                const range =
                    context.luckysheet_select_save[
                    context.luckysheet_select_save.length - 1
                        ];
                r = getRangetxt(
                    context,
                    context.currentSheetId,
                    range,
                    context.currentSheetId
                );
                return r;
            }
            return "";
        });
    }, [context, context.luckysheet_select_save]);

    return (
        <div
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-[90%] z-[100003] bg-background border border-border shadow-lg p-8 select-none outline-none"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            tabIndex={0}
        >
            <div className="text-base font-normal leading-6 mb-4 cursor-default">
                {dataVerification.selectCellRange}
            </div>
            <input
                className="h-[30px] px-2.5 border border-border outline-none select-none"
                readOnly
                placeholder={dataVerification.selectCellRange2}
                value={rangeTxt2}
            />
            <div className="flex gap-2 mt-3">
                <Button
                    size="sm"
                    onClick={() => {
                        setContext((ctx) => {
                            ctx.rangeDialog!.rangeTxt = rangeTxt2;
                        });
                        close();
                    }}
                >
                    {button.confirm}
                </Button>
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => close()}
                >
                    {button.close}
                </Button>
            </div>
        </div>
    );
};
export default RangeDialog;
