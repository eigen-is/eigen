import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';
import { cn } from '@workspace/ui/lib/utils';
import { useCallback, useContext, useMemo, useState } from 'react';
import { WorkbookContext } from '../../context';
import { useDialog } from '../../hooks/useDialog';
import { cancelNormalSelected, getSheetIndex, locale, update } from '../../state';

export function FormatSearch({
    type,
    onCancel: _onCancel,
}: {
    type: 'currency' | 'date' | 'number';
    onCancel: () => void;
}) {
    const {
        context,
        setContext,
        refs: { cellInput },
    } = useContext(WorkbookContext);
    const [decimalPlace, setDecimalPlace] = useState(2);
    const [selectedFormatIndex, setSelectedFormatIndex] = useState(0);
    const { button, format, currencyDetail, dateFmtList, numberFmtList } = locale(context);
    const { showDialog } = useDialog();
    type ToolbarFormatType = { name: string; pos?: string; value: string };

    const toolbarFormat: ToolbarFormatType[] = useMemo(() => {
        const list = type === 'currency' ? currencyDetail : type === 'date' ? dateFmtList : numberFmtList;
        if (type !== 'currency') return list;
        return [...list].sort((a, b) => {
            if (a.name === 'EUR') return -1;
            if (b.name === 'EUR') return 1;
            return a.name.localeCompare(b.name);
        });
    }, [type, currencyDetail, dateFmtList, numberFmtList]);

    const title =
        type === 'currency' ? format.titleCurrency : type === 'date' ? format.titleDateTime : format.titleNumber;

    const onConfirm = useCallback(() => {
        if (type !== 'date' && (decimalPlace < 0 || decimalPlace > 9)) {
            _onCancel();
            showDialog(format.tipDecimalPlaces, 'ok');
            return;
        }
        setContext((ctx) => {
            const index = getSheetIndex(ctx, ctx.currentSheetId);
            if (index == null) return;
            const selectedFormatVal = toolbarFormat[selectedFormatIndex].value;

            for (const selection of ctx.selections ?? []) {
                for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
                    for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
                        const cell = ctx.sheets[index].data?.[r][c];
                        if (!cell) continue;

                        if (type === 'date') {
                            if (!cell.ct) cell.ct = {};
                            cell.ct.fa = selectedFormatVal;
                            cell.ct.t = 'd';
                            cell.m = update(selectedFormatVal, cell.v);
                        } else if (cell.ct?.t === 'n') {
                            let selectedFormatPos: string = 'before';
                            if ('pos' in toolbarFormat[selectedFormatIndex])
                                selectedFormatPos = toolbarFormat[selectedFormatIndex].pos || 'before';
                            const zero = 0;
                            if (selectedFormatPos === 'after') {
                                cell.ct!.fa = zero.toFixed(decimalPlace).concat(`${selectedFormatVal}`);
                                cell.m = update(zero.toFixed(decimalPlace).concat(`${selectedFormatVal}`), cell.v);
                            } else {
                                cell.ct!.fa = `${selectedFormatVal}`.concat(zero.toFixed(decimalPlace));
                                cell.m = update(`${selectedFormatVal}`.concat(zero.toFixed(decimalPlace)), cell.v);
                            }
                        }
                    }
                }
            }
            _onCancel();
        });
    }, [
        _onCancel,
        type,
        decimalPlace,
        format.tipDecimalPlaces,
        selectedFormatIndex,
        setContext,
        showDialog,
        toolbarFormat,
    ]);

    const onCancel = useCallback(() => {
        setContext((ctx) => {
            cancelNormalSelected(ctx);
            if (cellInput.current) {
                cellInput.current.textContent = '';
            }
        });
        _onCancel();
    }, [_onCancel, cellInput, setContext]);

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
            </DialogHeader>
            {type !== 'date' && (
                <div className="flex items-center gap-2 shrink-0">
                    <Label className="text-sm whitespace-nowrap">{format.decimalPlaces}:</Label>
                    <Input
                        type="number"
                        min={0}
                        max={9}
                        defaultValue={2}
                        className="w-20 h-8"
                        onChange={(e) => setDecimalPlace(parseInt(e.target.value, 10))}
                    />
                </div>
            )}
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {toolbarFormat.map((v: ToolbarFormatType, index: number) => (
                    <div
                        className={cn(
                            'flex items-center justify-between px-3 py-1.5 text-sm border-b border-border eigen-list-item',
                            index === selectedFormatIndex && 'eigen-list-item-active',
                        )}
                        key={v.name}
                        onClick={() => setSelectedFormatIndex(index)}
                        tabIndex={0}
                    >
                        <span>{v.name}</span>
                        <span className="text-muted-foreground">{v.value}</span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={onCancel}>
                    {button.cancel}
                </Button>
                <Button size="sm" onClick={onConfirm}>
                    {button.confirm}
                </Button>
            </DialogFooter>
        </div>
    );
}
