import { Button } from '@workspace/ui/components/button';
import { Checkbox } from '@workspace/ui/components/checkbox';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { getDataArr, getFlowdata, getRegStr, updateMoreCell } from '../../state';

const SPLIT_SYMBOLS = [
    { name: 'Tab', value: 'Tab' },
    { name: 'semicolon', value: 'semicolon' },
    { name: 'comma', value: 'comma' },
    { name: 'space', value: 'space' },
];

export function SplitColumn() {
    const { context, setContext } = useContext(WorkbookContext);
    const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
    const [otherValue, setOtherValue] = useState('');
    const [tableData, setTableData] = useState<string[][]>([]);
    const { showDialog, hideDialog } = useDialog();

    const splitOperate = useMemo(() => getRegStr(selected, otherValue), [selected, otherValue]);

    const toggle = useCallback((id: string, checked: boolean) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    }, []);

    const certainBtn = useCallback(() => {
        hideDialog();
        const dataArr = getDataArr(splitOperate, context);
        const r = context.selections![0].row[0];
        const c = context.selections![0].column[0];
        if (dataArr[0].length === 1) return;
        let dataCover = false;
        const data = getFlowdata(context);
        for (let i = 0; i < dataArr.length; i += 1) {
            for (let j = 1; j < dataArr[0].length; j += 1) {
                const cell = data![r + i][c + j];
                if (cell != null && cell.v != null) {
                    dataCover = true;
                    break;
                }
            }
        }
        if (dataCover) {
            showDialog('There is already data here, do you want to replace it?', 'yesno', () => {
                hideDialog();
                setContext((ctx) => {
                    updateMoreCell(r, c, dataArr, ctx);
                });
            });
        } else {
            setContext((ctx) => {
                updateMoreCell(r, c, dataArr, ctx);
            });
        }
    }, [context, hideDialog, setContext, showDialog, splitOperate]);

    useEffect(() => {
        setTableData(getDataArr(splitOperate, context));
    }, [context, splitOperate]);

    return (
        <div className="select-none [&_table]:border-collapse [&_td]:border [&_td]:border-border">
            <DialogHeader>
                <DialogTitle>Split text</DialogTitle>
            </DialogHeader>
            <div className="mt-2.5">Delimiters</div>
            <div className="border p-1.5 my-1.5 space-y-1 text-sm">
                {SPLIT_SYMBOLS.map((o) => (
                    <Label key={o.value} className="flex items-center gap-1.5">
                        <Checkbox checked={selected.has(o.value)} onCheckedChange={(c) => toggle(o.value, !!c)} />
                        {o.name}
                    </Label>
                ))}
                <Label className="flex items-center gap-1.5">
                    <Checkbox checked={selected.has('other')} onCheckedChange={(c) => toggle('other', !!c)} />
                    Other
                    <Input
                        className="ml-1.5 h-7 w-[80px]"
                        value={otherValue}
                        onChange={(e) => setOtherValue(e.target.value)}
                    />
                </Label>
                <Label className="flex items-center gap-1.5">
                    <Checkbox
                        checked={selected.has('splitsimple')}
                        onCheckedChange={(c) => toggle('splitsimple', !!c)}
                    />
                    Consecutive separators are treated as a single
                </Label>
            </div>
            <div className="text-sm mt-6">Preview</div>
            <div className="border p-1.5 my-1.5 h-[100px] overflow-y-auto">
                <table>
                    <tbody>
                        {tableData.map((row, index) =>
                            row.length >= 1 ? (
                                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows rendered in a stable order
                                <tr key={index}>
                                    {row.map((cell) => (
                                        <td key={row + cell}>{cell}</td>
                                    ))}
                                </tr>
                            ) : (
                                // biome-ignore lint/suspicious/noArrayIndexKey: preview rows rendered in a stable order
                                <tr key={index}>
                                    <td />
                                </tr>
                            ),
                        )}
                    </tbody>
                </table>
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    Cancel
                </Button>
                <Button size="sm" onClick={() => certainBtn()}>
                    OK
                </Button>
            </DialogFooter>
        </div>
    );
}
