import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { useCallback, useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { getRangetxt, locale } from '../../state';
import { ConditionRules } from '../ConditionFormat/ConditionRules';
import { DataVerification } from '.';

export function RangeDialog() {
    const { context, setContext } = useContext(WorkbookContext);
    const { showDialog } = useDialog();
    const { dataVerification, button } = locale(context);
    const [rangeTxt2, setRangeTxt2] = useState<string>(context.rangeDialog?.rangeTxt ?? '');

    const close = useCallback(
        (commit: boolean) => {
            setContext((ctx) => {
                if (ctx.rangeDialog) {
                    if (commit) ctx.rangeDialog.rangeTxt = rangeTxt2;
                    ctx.rangeDialog.show = false;
                    ctx.rangeDialog.singleSelect = false;
                }
            });
            const rangeDialogType = context.rangeDialog?.type ?? '';
            if (rangeDialogType.includes('between')) {
                showDialog(<ConditionRules type="between" />);
                return;
            }
            if (rangeDialogType.includes('conditionRules')) {
                const rulesType = rangeDialogType.substring('conditionRules'.length);
                showDialog(<ConditionRules type={rulesType} />);
                return;
            }
            showDialog(<DataVerification />);
        },
        [context.rangeDialog, rangeTxt2, setContext, showDialog],
    );

    // Keep the input in sync with the user's selection in the spreadsheet.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-syncs when the selection changes; getRangetxt reads `context` directly
    useEffect(() => {
        if (!context.luckysheet_select_save) return;
        const range = context.luckysheet_select_save[context.luckysheet_select_save.length - 1];
        setRangeTxt2(getRangetxt(context, context.currentSheetId, range, context.currentSheetId));
    }, [context.luckysheet_select_save]);

    return (
        <>
            <DialogHeader>
                <DialogTitle className="text-base">{dataVerification.selectCellRange}</DialogTitle>
            </DialogHeader>
            <Input className="h-8" readOnly placeholder={dataVerification.selectCellRange2} value={rangeTxt2} />
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => close(false)}>
                    {button.close}
                </Button>
                <Button size="sm" onClick={() => close(true)}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </>
    );
}
