import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import produce from 'immer';
import { useCallback, useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { applyLocation, getFlowdata, getOptionValue, getSelectRange, locale } from '../../state';

const VALUE_KEYS = ['locationDate', 'locationDigital', 'locationString', 'locationBool', 'locationError'] as const;

const initialFlags: Record<(typeof VALUE_KEYS)[number], boolean> = {
    locationDate: true,
    locationDigital: true,
    locationString: true,
    locationBool: true,
    locationError: true,
};

export function LocationCondition() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog, hideDialog } = useDialog();
    const { findAndReplace, button } = locale(context);
    const [conditionType, setConditionType] = useState('locationConstant');
    const [constants, setConstants] = useState(initialFlags);
    const [formulas, setFormulas] = useState(initialFlags);

    const onConfirm = useCallback(() => {
        if (conditionType === 'locationConstant') {
            const value = getOptionValue(constants);
            const selectRange = getSelectRange(context);
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, value, ctx);
                if (rangeArr.length === 0) showDialog(findAndReplace.locationTipNotFindCell, 'ok');
            });
        } else if (conditionType === 'locationFormula') {
            const value = getOptionValue(formulas);
            const selectRange = getSelectRange(context);
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, value, ctx);
                if (rangeArr.length === 0) showDialog(findAndReplace.locationTipNotFindCell, 'ok');
            });
        } else if (conditionType === 'locationRowSpan') {
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].row[0] === context.luckysheet_select_save[0].row[1])
            ) {
                showDialog(findAndReplace.locationTiplessTwoRow, 'ok');
                return;
            }
            const selectRange = [...(context.luckysheet_select_save ?? [])];
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, undefined, ctx);
                if (rangeArr.length === 0) showDialog(findAndReplace.locationTipNotFindCell, 'ok');
            });
        } else if (conditionType === 'locationColumnSpan') {
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].column[0] === context.luckysheet_select_save[0].column[1])
            ) {
                showDialog(findAndReplace.locationTiplessTwoColumn, 'ok');
                return;
            }
            const selectRange = [...(context.luckysheet_select_save ?? [])];
            setContext((ctx) => {
                const rangeArr = applyLocation(selectRange, conditionType, undefined, ctx);
                if (rangeArr.length === 0) showDialog(findAndReplace.locationTipNotFindCell, 'ok');
            });
        } else {
            let selectRange: {
                row: (number | undefined)[];
                column: (number | undefined)[];
            }[];
            if (
                context.luckysheet_select_save?.length === 0 ||
                (context.luckysheet_select_save?.length === 1 &&
                    context.luckysheet_select_save[0].row[0] === context.luckysheet_select_save[0].row[1] &&
                    context.luckysheet_select_save[0].column[0] === context.luckysheet_select_save[0].column[1])
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
                const rangeArr = applyLocation(selectRange, conditionType, undefined, ctx);
                if (rangeArr.length === 0) showDialog(findAndReplace.locationTipNotFindCell, 'ok');
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

    return (
        <div>
            <div className="text-base leading-[48px]">{findAndReplace.location}</div>
            <RadioGroup value={conditionType} onValueChange={setConditionType} className="border p-2.5 text-sm gap-0">
                <div className="py-1.5">
                    <Label className="flex items-center gap-1.5">
                        <RadioGroupItem value="locationConstant" />
                        {findAndReplace.locationConstant}
                    </Label>
                    <div className="h-[30px] px-2.5 flex gap-3 mt-1">
                        {VALUE_KEYS.map((v) => (
                            <Label key={v} className="flex items-center gap-1.5 peer-disabled:opacity-50">
                                <Checkbox
                                    className="peer"
                                    disabled={conditionType !== 'locationConstant'}
                                    checked={constants[v]}
                                    onCheckedChange={() => {
                                        setConstants(
                                            produce((draft) => {
                                                draft[v] = !draft[v];
                                            }),
                                        );
                                    }}
                                />
                                {findAndReplace[v]}
                            </Label>
                        ))}
                    </div>
                </div>
                <div className="py-1.5">
                    <Label className="flex items-center gap-1.5">
                        <RadioGroupItem value="locationFormula" />
                        {findAndReplace.locationFormula}
                    </Label>
                    <div className="h-[30px] px-2.5 flex gap-3 mt-1">
                        {VALUE_KEYS.map((v) => (
                            <Label key={v} className="flex items-center gap-1.5 peer-disabled:opacity-50">
                                <Checkbox
                                    className="peer"
                                    disabled={conditionType !== 'locationFormula'}
                                    checked={formulas[v]}
                                    onCheckedChange={() => {
                                        setFormulas(
                                            produce((draft) => {
                                                draft[v] = !draft[v];
                                            }),
                                        );
                                    }}
                                />
                                {findAndReplace[v]}
                            </Label>
                        ))}
                    </div>
                </div>
                {(['locationNull', 'locationRowSpan', 'locationColumnSpan'] as const).map((v) => (
                    <Label key={v} className="flex items-center gap-1.5 py-1.5">
                        <RadioGroupItem value={v} />
                        {findAndReplace[v]}
                    </Label>
                ))}
            </RadioGroup>

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
                <Button
                    size="sm"
                    onClick={() => {
                        hideDialog();
                        onConfirm();
                    }}
                >
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}
