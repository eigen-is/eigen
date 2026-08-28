import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { en, getRangetxt, isLinkValid } from '../../state';

type CellRangeDialogProps = {
    value: string;
    editable?: boolean;
    // Cell-range links are followed from any sheet, so their text carries the sheet name.
    includeSheetName?: boolean;
    onConfirm: (rangeTxt: string) => void;
    onCancel: () => void;
};

export function CellRangeDialog({ value, editable, includeSheetName, onConfirm, onCancel }: CellRangeDialogProps) {
    const { context } = useContext(WorkbookContext);
    const { insertLink, dataVerification, button } = en;
    const [rangeTxt, setRangeTxt] = useState<string>(value);

    // Only a typed range can be malformed — one picked on the grid never is.
    const validity = editable ? isLinkValid('cellrange', rangeTxt) : { isValid: true, tooltip: '' };

    // Keep the field in sync with the user's selection in the spreadsheet.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-syncs when the selection changes; getRangetxt reads `context` directly
    useEffect(() => {
        if (!context.selections) return;
        const range = context.selections[context.selections.length - 1];
        const currentId = includeSheetName ? '' : context.currentSheetId;
        setRangeTxt(getRangetxt(context, context.currentSheetId, range, currentId));
    }, [context.selections]);

    return (
        <>
            <DialogHeader>
                <DialogTitle>{insertLink.selectCellRange}</DialogTitle>
            </DialogHeader>
            {editable ? (
                <div>
                    <Input
                        className={cn('h-8', !validity.isValid && rangeTxt && 'border-destructive')}
                        spellCheck={false}
                        placeholder={insertLink.cellRangePlaceholder}
                        value={rangeTxt}
                        onChange={(e) => setRangeTxt(e.target.value)}
                    />
                    <div className="h-[17px] my-[3px] text-xs text-destructive">{validity.tooltip}</div>
                </div>
            ) : (
                // A value display, not a text box: an input would take the dialog's opening
                // focus and render focus-ringed with its value selected.
                <div className="flex h-8 items-center rounded-md border border-input px-3 text-sm">
                    {rangeTxt || <span className="text-muted-foreground">{dataVerification.selectCellRange2}</span>}
                </div>
            )}
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
                <Button size="sm" disabled={!validity.isValid} onClick={() => onConfirm(rangeTxt)}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </>
    );
}
