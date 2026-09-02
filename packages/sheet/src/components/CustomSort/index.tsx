import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { type Context, getSheetIndex, indexToColumnChar, sortSelection } from '../../state';

export function CustomSort() {
    const [rangeColChar, setRangeColChar] = useState<string[]>([]);
    const [ascOrDesc, setAscOrDesc] = useState(true);
    const { context, setContext } = useContext(WorkbookContext);
    const [selectedValue, setSelectedValue] = useState<string>('0');
    const [isTitleChange, setIsTitleChange] = useState(false);
    const { hideDialog } = useDialog();

    const col_start = context.selections![0].column[0];
    const col_end = context.selections![0].column[1];
    const row_start = context.selections![0].row[0];
    const row_end = context.selections![0].row[1];

    const sheetIndex = getSheetIndex(context, context.currentSheetId) as number;

    useEffect(() => {
        const list: string[] = [];
        if (isTitleChange) {
            for (let i = col_start; i <= col_end; i += 1) {
                const cell = context.sheets[sheetIndex].data?.[row_start]?.[i];
                const colHeaderValue = cell?.m || cell?.v;
                if (colHeaderValue) {
                    list.push(colHeaderValue as string);
                } else {
                    const ColumnChar = indexToColumnChar(i);
                    list.push(`Column ${ColumnChar}`);
                }
            }
        } else {
            for (let i = col_start; i <= col_end; i += 1) {
                const ColumnChar = indexToColumnChar(i);
                list.push(ColumnChar);
            }
        }
        setRangeColChar(list);
    }, [col_end, col_start, context.sheets, isTitleChange, row_start, sheetIndex]);

    return (
        <div className="flex flex-col gap-4">
            <DialogHeader>
                <DialogTitle>Custom sort</DialogTitle>
            </DialogHeader>
            <div className="text-sm">
                Sort range from {`${indexToColumnChar(col_start)}${row_start + 1}`} to{' '}
                {`${indexToColumnChar(col_end)}${row_end + 1}`}
            </div>

            <div className="space-y-2.5">
                <Label className="flex items-center gap-1.5">
                    <Checkbox checked={isTitleChange} onCheckedChange={(v) => setIsTitleChange(!!v)} />
                    Data has a header row
                </Label>

                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 flex-1">
                        <span>Sort by</span>
                        <Select value={selectedValue} onValueChange={setSelectedValue}>
                            <SelectTrigger size="sm" className="w-full">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {rangeColChar.map((col, index) => (
                                    <SelectItem value={String(index)} key={col}>
                                        {col}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <RadioGroup
                        value={ascOrDesc ? 'asc' : 'desc'}
                        onValueChange={(v) => setAscOrDesc(v === 'asc')}
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

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    close
                </Button>
                <Button
                    size="sm"
                    onClick={() => {
                        setContext((draftCtx: Context) => {
                            sortSelection(draftCtx, ascOrDesc, parseInt(selectedValue, 10));
                        });
                        hideDialog();
                    }}
                >
                    sort
                </Button>
            </DialogFooter>
        </div>
    );
}
