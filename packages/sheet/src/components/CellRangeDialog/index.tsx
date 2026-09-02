import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { cn } from '@workspace/ui/lib/utils';
import { useContext, useEffect, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { getRangetxt, isLinkValid } from '../../state';

type CellRangeDialogProps = {
    value: string;
    // 'link' is followed from any sheet, so it is typeable and its text carries the sheet
    // name; 'validation' is pick-only and always relative to the current sheet.
    variant: 'link' | 'validation';
    onConfirm: (rangeTxt: string) => void;
    onCancel: () => void;
};

export function CellRangeDialog({ value, variant, onConfirm, onCancel }: CellRangeDialogProps) {
    const { context } = useContext(WorkbookContext);
    const [rangeTxt, setRangeTxt] = useState<string>(value);
    const isLink = variant === 'link';

    // Only a typed range can be malformed — one picked on the grid never is.
    const validity = isLinkValid('cellrange', rangeTxt);
    const invalid = isLink && !validity.isValid;

    // The picker opens seeded from the stored range (an existing cell-range link, the
    // data-validation range), so the mount pass has to be skipped — it would overwrite
    // that with the grid's current selection before the user picks anything.
    const skipFirstSync = useRef(true);

    // Keep the field in sync with the user's selection in the spreadsheet.
    // biome-ignore lint/correctness/useExhaustiveDependencies: only re-syncs when the selection changes; getRangetxt reads `context` directly
    useEffect(() => {
        if (skipFirstSync.current) {
            skipFirstSync.current = false;
            return;
        }
        if (!context.selections) return;
        const range = context.selections[context.selections.length - 1];
        const currentId = isLink ? '' : context.currentSheetId;
        setRangeTxt(getRangetxt(context, context.currentSheetId, range, currentId));
    }, [context.selections]);

    return (
        <>
            <DialogHeader>
                <DialogTitle>Select cell range</DialogTitle>
            </DialogHeader>
            {isLink ? (
                <div className="space-y-1.5">
                    <Input
                        className={cn('h-8', invalid && rangeTxt && 'border-destructive')}
                        spellCheck={false}
                        placeholder="Select cells using the cursor or enter directly"
                        value={rangeTxt}
                        onChange={(e) => setRangeTxt(e.target.value)}
                    />
                    {invalid && rangeTxt && <p className="text-xs text-destructive">{validity.tooltip}</p>}
                </div>
            ) : (
                // A value display, not a text box: tabIndex -1 keeps it out of Radix
                // FocusScope's tabbable candidates, which would otherwise take the dialog's
                // opening focus and render it focus-ringed with its value selected.
                <Input
                    className="h-8"
                    readOnly
                    tabIndex={-1}
                    placeholder="Please select a range of cells"
                    value={rangeTxt}
                />
            )}
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    Cancel
                </Button>
                <Button size="sm" disabled={invalid} onClick={() => onConfirm(rangeTxt)}>
                    OK
                </Button>
            </DialogFooter>
        </>
    );
}
