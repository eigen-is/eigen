// The range picker: a small dialog that names the range selected on the grid, for a link or a validation rule to
// use. It opens in the slot's non-modal shell, so the grid stays usable to pick on, and its field follows the
// selection. Its opener decides what Select and Cancel do, such as opening its own dialog again with the pick. Its
// form takes Enter and Cmd+Enter as a dialog form does, and Select waits until there is a range.

import { DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { FieldError } from '@workspace/ui/components/field';
import { FormFooter } from '@workspace/ui/components/form-dialog';
import { FormShell } from '@workspace/ui/components/form-shell';
import { Input } from '@workspace/ui/components/input';
import { useContext, useEffect, useId, useRef, useState } from 'react';
import { WorkbookContext } from '../../context';
import { getRangetxt, isLinkValid } from '../../state';

// What a form that takes a range says when it names no cells, such as a link's or a validation rule's.
export const NO_RANGE_MESSAGE = 'Enter a cell range, such as A1:B10';

type CellRangeDialogProps = {
    value: string;
    // A link is followed from any sheet, so it is typeable and its text carries the sheet name. A validation range is
    // pick-only and relative to the current sheet.
    variant: 'link' | 'validation';
    onConfirm: (rangeTxt: string) => void;
    onCancel: () => void;
};

export function CellRangeDialog({ value, variant, onConfirm, onCancel }: CellRangeDialogProps) {
    const { context } = useContext(WorkbookContext);
    const [rangeTxt, setRangeTxt] = useState(value);
    const isLink = variant === 'link';
    const refusalId = useId();

    // Only a typed range can be malformed, never one picked on the grid.
    const validity = isLinkValid('cellrange', rangeTxt);
    const invalid = isLink && !validity.isValid;

    // The picker opens on the stored range, such as an existing link's. The sync below skips its mount pass, which
    // would overwrite that with the grid's selection before the user picks anything.
    const skipFirstSync = useRef(true);

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
            <FormShell
                className="flex flex-col gap-4"
                onSubmit={() => {
                    if (invalid) return false;
                    onConfirm(rangeTxt);
                }}
            >
                {isLink ? (
                    <div className="space-y-1.5">
                        <Input
                            aria-label="Cell range"
                            aria-invalid={invalid && !!rangeTxt}
                            aria-describedby={invalid && rangeTxt ? refusalId : undefined}
                            spellCheck={false}
                            placeholder="Select cells using the cursor or enter directly"
                            value={rangeTxt}
                            onChange={(e) => setRangeTxt(e.target.value)}
                        />
                        {invalid && rangeTxt && <FieldError id={refusalId}>{validity.tooltip}</FieldError>}
                    </div>
                ) : (
                    // A value display, not a text box. Out of the tab order, Radix doesn't give it the opening focus,
                    // which would draw it with a ring and its value selected.
                    <Input
                        aria-label="Cell range"
                        readOnly
                        tabIndex={-1}
                        placeholder="Select a range of cells"
                        value={rangeTxt}
                    />
                )}
                <FormFooter pending={false} onCancel={onCancel} canSubmit={!!rangeTxt} submitLabel="Select" />
            </FormShell>
        </>
    );
}
