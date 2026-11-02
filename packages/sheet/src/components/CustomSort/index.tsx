// The Custom sort dialog, opened from the Data menu: it sorts the selected range by one of its columns, ascending
// or descending. With Data has a header row ticked, the Sort by choices take their names from the range's first row,
// and that row stays in place.

import { columnIndexToLabel } from '@workspace/lib/sheets';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { FormDialog, FormDialogForm } from '@workspace/ui/components/form-dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { toA1 } from '../../engine/a1-notation';
import { cellDisplay } from '../../engine/format';
import { useDialogProps } from '../../hooks/useDialog';
import type { Selection } from '../../state';
import { clipToUsedExtent, getFlowdata, sortRange } from '../../state';

// `selection` is the one range selected as the dialog opened, which the sort sorts.
export function CustomSort({ selection }: { selection: Selection }) {
    const { context, setContext } = useContext(WorkbookContext);
    const dialogProps = useDialogProps();
    const [hasHeaderRow, setHasHeaderRow] = useState(false);
    // The position in the range of the column to sort by, as the Select's value.
    const [sortColumn, setSortColumn] = useState('0');
    const [ascending, setAscending] = useState(true);

    // A whole-row selection spans every column of the sheet. Only the ones up to the last that holds data are worth
    // sorting by, and the rest would be thousands of empty choices.
    const [range] = clipToUsedExtent(context, [selection]);
    const {
        row: [rowStart],
        column: [columnStart, columnEnd],
    } = range;

    const data = getFlowdata(context);
    const columns: { offset: number; label: string }[] = [];
    for (let c = columnStart; c <= columnEnd; c += 1) {
        const letter = columnIndexToLabel(c);
        const cell = data?.[rowStart]?.[c];
        const header = cellDisplay(cell) || cell?.v;
        let label = letter;
        if (hasHeaderRow) label = header ? String(header) : `Column ${letter}`;
        columns.push({ offset: c - columnStart, label });
    }

    return (
        <FormDialog {...dialogProps} title="Custom sort" size="md">
            <FormDialogForm
                submitLabel="Sort"
                onSubmit={() =>
                    setContext((draftCtx) => {
                        sortRange(draftCtx, selection, ascending, Number(sortColumn), hasHeaderRow);
                    })
                }
            >
                <p className="text-sm">
                    Sort range from {toA1(range.row[0], columnStart)} to {toA1(range.row[1], columnEnd)}
                </p>

                <div className="space-y-2.5">
                    <Label className="flex items-center gap-1.5">
                        <Checkbox checked={hasHeaderRow} onCheckedChange={(v) => setHasHeaderRow(v === true)} />
                        Data has a header row
                    </Label>

                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-2 flex-1">
                            <span>Sort by</span>
                            <Select value={sortColumn} onValueChange={setSortColumn}>
                                <SelectTrigger size="sm" className="w-full">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {columns.map(({ offset, label }) => (
                                        <SelectItem value={String(offset)} key={offset}>
                                            {label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <RadioGroup
                            value={ascending ? 'asc' : 'desc'}
                            onValueChange={(v) => setAscending(v === 'asc')}
                            className="gap-1.5"
                        >
                            <Label className="flex items-center gap-1.5">
                                <RadioGroupItem value="asc" />
                                Ascending
                            </Label>
                            <Label className="flex items-center gap-1.5">
                                <RadioGroupItem value="desc" />
                                Descending
                            </Label>
                        </RadioGroup>
                    </div>
                </div>
            </FormDialogForm>
        </FormDialog>
    );
}
