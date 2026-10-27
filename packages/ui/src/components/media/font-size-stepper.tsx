// The font size control of a formatting toolbar, such as the docs and sheets toolbars: a box between a
// minus and a plus button. The buttons step the size, and the box applies a typed size on Enter or blur
// and drops it on Escape.

import { readFontSize } from '@workspace/lib/constants/fonts';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

type FontSizeStepperProps = {
    // None for a selection of mixed sizes, which shows an empty box, as Google's does.
    value: number | undefined;
    onChange: (size: number) => void;
    onStep: (by: 1 | -1) => void;
};

// Google Docs' and Sheets' "− [11] +", as narrow as theirs: a 32px box between 24px buttons.
export function FontSizeStepper({ value, onChange, onStep }: FontSizeStepperProps) {
    const shown = value === undefined ? '' : String(value);
    // Editable buffer so typing doesn't apply on every keystroke; commit on blur/Enter.
    const [draft, setDraft] = useState(shown);
    // Escape blurs too, and that blur's handler still holds the typed draft.
    const escaped = useRef(false);

    // Follow the selection when it moves or a step button fires.
    useEffect(() => {
        setDraft(shown);
    }, [shown]);

    const commit = () => {
        const size = escaped.current ? undefined : readFontSize(Number.parseFloat(draft));
        escaped.current = false;
        if (size !== undefined && size !== value) onChange(size);
        else setDraft(shown);
    };

    return (
        <div className="flex items-center">
            <TooltipButton
                icon={Minus}
                tooltipText="Decrease font size"
                className="h-6 w-6"
                preventFocusLoss
                onClick={() => onStep(-1)}
            />
            <input
                value={draft}
                inputMode="decimal"
                aria-label="Font size"
                className="h-6 w-8 rounded-md border border-input bg-background px-0 text-center text-xs tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    // Typing here is the box's, not the keys of the editor or grid around it. The size applies
                    // as the box blurs, and the focus may go on to an editor, so Enter's own action is
                    // dropped: it would type a line break over the editor's selection.
                    e.stopPropagation();
                    if (e.key === 'Escape') escaped.current = true;
                    if (e.key === 'Enter') e.preventDefault();
                    if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
                }}
            />
            <TooltipButton
                icon={Plus}
                tooltipText="Increase font size"
                className="h-6 w-6"
                preventFocusLoss
                onClick={() => onStep(1)}
            />
        </div>
    );
}
