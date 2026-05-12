import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter } from '@workspace/ui/components/dialog';
import { Label } from '@workspace/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@workspace/ui/components/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@workspace/ui/components/select';
import { useContext, useEffect, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { type Context, getSheetIndex, indexToColumnChar, locale, sortSelection } from '../../state';

export function CustomSort() {
    const [rangeColChar, setRangeColChar] = useState<string[]>([]);
    const [ascOrDesc, setAscOrDesc] = useState(true);
    const { context, setContext } = useContext(WorkbookContext);
    const [selectedValue, setSelectedValue] = useState<string>('0');
    const [isTitleChange, setIsTitleChange] = useState(false);
    const { sort } = locale(context);
    const { hideDialog } = useDialog();

    const col_start = context.luckysheet_select_save![0].column[0];
    const col_end = context.luckysheet_select_save![0].column[1];
    const row_start = context.luckysheet_select_save![0].row[0];
    const row_end = context.luckysheet_select_save![0].row[1];

    const sheetIndex = getSheetIndex(context, context.currentSheetId) as number;

    useEffect(() => {
        const list: string[] = [];
        if (isTitleChange) {
            for (let i = col_start; i <= col_end; i += 1) {
                const cell = context.luckysheetfile[sheetIndex].data?.[row_start]?.[i];
                const colHeaderValue = cell?.m || cell?.v;
                if (colHeaderValue) {
                    list.push(colHeaderValue as string);
                } else {
                    const ColumnChar = indexToColumnChar(i);
                    list.push(`${sort.columnOperation} ${ColumnChar}`);
                }
            }
        } else {
            for (let i = col_start; i <= col_end; i += 1) {
                const ColumnChar = indexToColumnChar(i);
                list.push(ColumnChar);
            }
        }
        setRangeColChar(list);
    }, [col_end, col_start, context.luckysheetfile, isTitleChange, row_start, sheetIndex, sort.columnOperation]);

    return (
        <>
            <div className="text-base mb-4">
                <span>
                    <span>{sort.sortRangeTitle}</span>
                    {indexToColumnChar(col_start)}
                    {row_start + 1}
                    <span>{sort.sortRangeTitleTo}</span>
                    {indexToColumnChar(col_end)}
                    {row_end + 1}
                </span>
            </div>

            <div className="space-y-2.5">
                <Label className="flex items-center gap-1.5">
                    <Checkbox checked={isTitleChange} onCheckedChange={(v) => setIsTitleChange(!!v)} />
                    {sort.hasTitle}
                </Label>

                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 flex-1">
                        <span>{sort.sortBy}</span>
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
                            {sort.asc}
                        </Label>
                        <Label className="flex items-center gap-1.5">
                            <RadioGroupItem value="desc" />
                            {sort.desc}
                        </Label>
                    </RadioGroup>
                </div>
            </div>

            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {sort.close}
                </Button>
                <Button
                    size="sm"
                    onClick={() => {
                        setContext((draftCtx: Context) => {
                            sortSelection(draftCtx, ascOrDesc, parseInt(selectedValue, 10));
                            draftCtx.contextMenu = {};
                        });
                        hideDialog();
                    }}
                >
                    {sort.confirm}
                </Button>
            </DialogFooter>
        </>
    );
}
