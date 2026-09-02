import { Button } from '@workspace/ui/components/button';
import { DialogFooter, DialogHeader, DialogTitle } from '@workspace/ui/components/dialog';
import { Input } from '@workspace/ui/components/input';
import { useContext, useState } from 'react';
import { WorkbookContext } from '../../context';
import { update } from '../../engine/format';
import { useDialog } from '../../hooks/useDialog';
import { handleNumberFormat } from '../../state';
import { NUMBER_FORMAT_PRESETS, previewPattern } from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

export function CustomNumberFormats() {
    const { setContext, refs } = useContext(WorkbookContext);
    const { hideDialog } = useDialog();

    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const sampleValue = typeof anchor?.v === 'number' ? anchor.v : 1234.56;
    const [pattern, setPattern] = useState(
        anchorFa && anchorFa !== 'General' && anchorFa !== '@' ? anchorFa : '#,##0.00',
    );

    const sample = previewPattern(pattern, sampleValue);

    const apply = () => {
        setContext((ctx) => {
            handleNumberFormat(ctx, refs.cellInput.current!, pattern);
        });
        hideDialog();
    };

    return (
        <div className="flex flex-col min-h-0 flex-1 gap-4">
            <DialogHeader>
                <DialogTitle>Custom number formats</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 shrink-0">
                <Input className="font-mono" value={pattern} onChange={(e) => setPattern(e.target.value)} />
                {sample.ok ? (
                    <div className="text-sm text-muted-foreground">
                        Sample: <span className="text-foreground">{sample.text}</span>
                    </div>
                ) : (
                    <div className="text-sm text-destructive">{sample.error}</div>
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
                    Cancel
                </Button>
                <Button size="sm" disabled={!pattern || !sample.ok} onClick={apply}>
                    Apply
                </Button>
            </DialogFooter>
        </div>
    );
}
