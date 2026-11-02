// The Split text dialog, opened from the Data menu: the separators to cut the selected column at, a preview of the
// pieces, and a question before the pieces overwrite cells to the right of the column.

import { Checkbox } from '@workspace/ui/components/checkbox';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { cellValue } from '../../engine/format';
import { useDialog, useDialogProps } from '../../hooks/useDialog';
import { getDataArr, getFlowdata, getRegStr, updateMoreCell } from '../../state';

// Each is its own label and the id getRegStr reads.
const SEPARATORS = ['Tab', 'semicolon', 'comma', 'space'];

export function SplitColumn() {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const { showDialog } = useDialog();
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const [otherValue, setOtherValue] = useState('');

    const pieces = getDataArr(getRegStr(selected, otherValue), context);

    const toggle = (id: string, checked: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    // The question takes the slot over, so this dialog's own close after the submit does nothing.
    const split = () => {
        const selection = context.selections?.[0];
        const data = getFlowdata(context);
        // The dialog opens on a selected column of a loaded sheet. One piece per cell leaves nothing to split.
        if (!selection || !data || pieces[0].length === 1) return;
        const r = selection.row[0];
        const c = selection.column[0];
        const write = () =>
            setContext((ctx) => {
                updateMoreCell(r, c, pieces, ctx);
            });
        let overwrites = false;
        for (let i = 0; i < pieces.length; i += 1) {
            for (let j = 1; j < pieces[0].length; j += 1) {
                if (cellValue(data[r + i][c + j]) != null) overwrites = true;
            }
        }
        if (overwrites) showDialog('There is already data here, do you want to replace it?', 'yesno', write);
        else write();
    };

    return (
        <FormDialog {...dialogProps} title="Split text" size="md">
            <FormDialogForm submitLabel="OK" onSubmit={split}>
                <div className="select-none [&_table]:border-collapse [&_td]:border [&_td]:border-border">
                    <div>Delimiters</div>
                    <div className="border p-1.5 my-1.5 space-y-1 text-sm">
                        {SEPARATORS.map((separator) => (
                            <Label key={separator} className="flex items-center gap-1.5">
                                <Checkbox
                                    checked={selected.has(separator)}
                                    onCheckedChange={(c) => toggle(separator, c === true)}
                                />
                                {separator}
                            </Label>
                        ))}
                        <Label className="flex items-center gap-1.5">
                            <Checkbox
                                checked={selected.has('other')}
                                onCheckedChange={(c) => toggle('other', c === true)}
                            />
                            Other
                            <Input
                                className="ml-1.5 h-7 w-[80px]"
                                aria-label="Other separator"
                                value={otherValue}
                                onChange={(e) => setOtherValue(e.target.value)}
                            />
                        </Label>
                        <Label className="flex items-center gap-1.5">
                            <Checkbox
                                checked={selected.has('splitsimple')}
                                onCheckedChange={(c) => toggle('splitsimple', c === true)}
                            />
                            Consecutive separators are treated as a single
                        </Label>
                    </div>
                    <div className="text-sm mt-6">Preview</div>
                    <div className="border p-1.5 my-1.5 h-[100px] overflow-y-auto">
                        <table>
                            <tbody>
                                {Array.from(pieces.entries(), ([rowIndex, row]) => (
                                    <tr key={rowIndex}>
                                        {row.length === 0 ? (
                                            <td />
                                        ) : (
                                            Array.from(row.entries(), ([column, cell]) => <td key={column}>{cell}</td>)
                                        )}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}
