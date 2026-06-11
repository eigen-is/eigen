import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import { getFlowdata, locale, updateFormat } from '../../state';
import { NUMBER_FORMAT_PRESETS } from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

export function CustomNumberFormats() {
    const { context, setContext, refs } = useContext(WorkbookContext);
    const { button, format } = locale(context);
    const { hideDialog } = useDialog();

    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const sampleValue = typeof anchor?.v === 'number' ? anchor.v : 1234.56;
    const [pattern, setPattern] = useState(
        anchorFa && anchorFa !== 'General' && anchorFa !== '@' ? anchorFa : '#,##0.00',
    );

    let sample = '';
    let error: string | null = null;
    try {
        sample = update(pattern, sampleValue);
    } catch (e) {
        error = (e as Error).message;
    }

    const apply = () => {
        setContext((ctx) => {
            const d = getFlowdata(ctx);
            if (d == null) return;
            updateFormat(ctx, refs.cellInput.current!, d, 'ct', pattern);
        });
        hideDialog();
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>{format.titleNumber}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 shrink-0">
                <Input className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
                {error ? (
                    <div className="text-sm text-destructive">{error}</div>
                ) : (
                    <div className="text-sm text-muted-foreground">
                        {format.sample}: <span className="text-foreground">{sample}</span>
                    </div>
                )}
            </div>
            <div className="flex-1 min-h-0 border border-border rounded-md overflow-y-auto">
                {NUMBER_FORMAT_PRESETS.map((preset) => (
                    <div
                        className="flex items-center justify-between gap-4 px-3 py-1.5 text-sm border-b border-border eigen-list-item"
                        key={preset}
                        onClick={() => setPattern(preset)}
                        tabIndex={0}
                    >
                        <span className="font-mono">{preset}</span>
                        <span className="text-muted-foreground">{update(preset, sampleValue)}</span>
                    </div>
                ))}
            </div>
            <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => hideDialog()}>
                    {button.cancel}
                </Button>
                <Button size="sm" disabled={!pattern || error != null} onClick={apply}>
                    {button.apply}
                </Button>
            </DialogFooter>
        </div>
    );
}
