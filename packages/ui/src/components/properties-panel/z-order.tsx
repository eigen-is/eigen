// Shared z-order ("Arrange") chrome. The WRITE stays with the host, over lib's `zOrderKeys`, so this
// module owns the UI only: the four Arrange buttons and the keyboard brackets. Each host folds its own
// gates into `enabled` and passes an `onApply` wired to its own reorder.

import type { ZOp } from '@workspace/lib/vector';
import { BringToFront, ChevronDown, ChevronUp, SendToBack } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

// Every z-order op's label and hotkey, front first as Google Slides' Order ▸ lists them.
export const Z_ORDER_ROWS: readonly { op: ZOp; label: string; hotkey: string }[] = [
    { op: 'toFront', label: 'Bring to front', hotkey: 'Mod+Shift+]' },
    { op: 'forward', label: 'Bring forward', hotkey: 'Mod+]' },
    { op: 'backward', label: 'Send backward', hotkey: 'Mod+[' },
    { op: 'toBack', label: 'Send to back', hotkey: 'Mod+Shift+[' },
];

const BUTTON_ICONS = { toBack: SendToBack, backward: ChevronDown, forward: ChevronUp, toFront: BringToFront };

// The Arrange row, back to front. Presentational — the host owns what each op does.
export function ZOrderButtons({ onApply }: { onApply: (op: ZOp) => void }) {
    return (
        <div className="flex items-center gap-1">
            {Z_ORDER_ROWS.toReversed().map(({ op, label }) => (
                <TooltipButton
                    key={op}
                    className="h-7 w-7"
                    icon={BUTTON_ICONS[op]}
                    tooltipText={label}
                    onClick={() => onApply(op)}
                />
            ))}
        </div>
    );
}

// Z-order: ⌘[/⌘] step, ⌘⇧[/⌘⇧] to back/front. A manual `event.code` listener, NOT the hotkey lib:
// the lib matches by event.key (⌘⇧[ arrives as '{') and its type surface forbids Shift+punctuation.
// Owns isTypingTarget() + preventDefault so live focus is read at keydown time. The host folds its
// gates (canWrite && !editing && hasSelection) into `enabled`; state is read from a ref so this
// document listener, registered once, never goes stale.
export function useZOrderHotkeys(enabled: boolean, onApply: (op: ZOp) => void): void {
    const stateRef = useRef({ enabled, onApply });
    stateRef.current = { enabled, onApply };
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            if (e.code !== 'BracketLeft' && e.code !== 'BracketRight') return;
            const { enabled: on, onApply: apply } = stateRef.current;
            if (!on || isTypingTarget()) return;
            e.preventDefault();
            const hotkey = `Mod+${e.shiftKey ? 'Shift+' : ''}${e.code === 'BracketLeft' ? '[' : ']'}`;
            const row = Z_ORDER_ROWS.find((r) => r.hotkey === hotkey);
            if (row) apply(row.op);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);
}
