// The Custom number formats dialog: a pattern field with the format of the focus cell, a live preview on a
// sample value, and presets. Apply sets the pattern on the selection through handleNumberFormat.

import { numberDisplay } from '@workspace/formula/format';
import { Input } from '@workspace/ui/components/input';
import { useId, useState } from 'react';
import { FormatDialog, PatternPreview, PresetList, PresetRow } from './format-dialog';
import { NUMBER_FORMAT_PRESETS, previewPattern } from './format-pattern';
import { useAnchorCell } from './useAnchorCell';

export function CustomNumberFormats() {
    const anchor = useAnchorCell();
    const anchorFa = anchor?.ct?.fa;
    const sampleValue = typeof anchor?.v === 'number' ? anchor.v : 1234.56;
    const [opened] = useState(anchorFa && anchorFa !== 'General' && anchorFa !== '@' ? anchorFa : '#,##0.00');
    const [pattern, setPattern] = useState(opened);
    const problemId = useId();

    const preview = previewPattern(pattern, sampleValue);

    return (
        <FormatDialog
            title="Custom number formats"
            pattern={pattern}
            changed={pattern !== opened}
            error={preview.ok ? undefined : preview.error}
            missing={pattern ? undefined : 'Enter a number format'}
        >
            {(problem) => (
                <>
                    <div className="flex flex-col gap-1.5">
                        <Input
                            className="font-mono"
                            aria-label="Number format"
                            aria-invalid={problem !== undefined}
                            aria-describedby={problem && problemId}
                            value={pattern}
                            onChange={(e) => setPattern(e.target.value)}
                        />
                        <PatternPreview id={problemId} preview={preview} problem={problem} />
                    </div>
                    <PresetList>
                        {NUMBER_FORMAT_PRESETS.map((preset) => (
                            <PresetRow key={preset} active={preset === pattern} onPick={() => setPattern(preset)}>
                                <span className="font-mono">{preset}</span>
                                <span className="text-muted-foreground">{numberDisplay(sampleValue, preset)}</span>
                            </PresetRow>
                        ))}
                    </PresetList>
                </>
            )}
        </FormatDialog>
    );
}
