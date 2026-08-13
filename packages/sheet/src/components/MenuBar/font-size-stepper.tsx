import { TooltipButton } from '@workspace/ui';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

const MIN_SIZE = 6;
const MAX_SIZE = 96;

const clampSize = (size: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));

type FontSizeStepperProps = {
    value: number;
    onChange: (size: number) => void;
};

export function FontSizeStepper({ value, onChange }: FontSizeStepperProps) {
    // Editable buffer so typing doesn't apply on every keystroke; commit on blur/Enter.
    const [draft, setDraft] = useState(String(value));

    // Follow the focused cell when the selection moves or a step button fires.
    useEffect(() => {
        setDraft(String(value));
    }, [value]);

    const commit = () => {
        const parsed = Number.parseInt(draft, 10);
        if (Number.isFinite(parsed)) {
            onChange(clampSize(parsed));
        } else {
            setDraft(String(value));
        }
    };

    return (
        <div className="flex items-center gap-0.5">
            <TooltipButton
                icon={Minus}
                tooltipText="Decrease font size"
                preventFocusLoss
                onClick={() => onChange(clampSize(value - 1))}
            />
            <input
                value={draft}
                inputMode="numeric"
                aria-label="Font size"
                className="h-7 w-10 rounded-md border border-input bg-background text-center text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    // Typing here must not reach the workbook's onKeyDown (grid navigation / cell edit).
                    e.stopPropagation();
                    if (e.key === 'Enter') {
                        commit();
                        e.currentTarget.blur();
                    } else if (e.key === 'Escape') {
                        setDraft(String(value));
                        e.currentTarget.blur();
                    }
                }}
            />
            <TooltipButton
                icon={Plus}
                tooltipText="Increase font size"
                preventFocusLoss
                onClick={() => onChange(clampSize(value + 1))}
            />
        </div>
    );
}
