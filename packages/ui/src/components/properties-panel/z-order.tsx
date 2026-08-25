// Shared z-order ("Arrange") vocabulary + chrome for canvas apps (vector, slides). The WRITES stay
// per-app — vector rewrites fractional indices, slides splices a Y.Array — so this module owns the
// verbs and the UI only: the `ZOp` union, the four Arrange buttons, and the keyboard brackets. Each
// host folds its own gates into `enabled` and passes an `onApply` wired to its own reorder.

import { BringToFront, ChevronDown, ChevronUp, SendToBack } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { isTypingTarget } from '../../hooks/is-typing-target';
import { TooltipButton } from '../layout/toolbar/tooltip-button';

export type ZOp = 'backward' | 'forward' | 'toBack' | 'toFront';

// The Arrange row: send-to-back / send-backward / bring-forward / bring-to-front. Presentational —
// the host owns what each op does.
export function ZOrderButtons({ onApply }: { onApply: (op: ZOp) => void }) {
    return (
        <div className="flex items-center gap-1">
            <TooltipButton
                className="h-7 w-7"
                icon={SendToBack}
                tooltipText="Send to back"
                onClick={() => onApply('toBack')}
            />
            <TooltipButton
                className="h-7 w-7"
                icon={ChevronDown}
                tooltipText="Send backward"
                onClick={() => onApply('backward')}
            />
            <TooltipButton
                className="h-7 w-7"
                icon={ChevronUp}
                tooltipText="Bring forward"
                onClick={() => onApply('forward')}
            />
            <TooltipButton
                className="h-7 w-7"
                icon={BringToFront}
                tooltipText="Bring to front"
                onClick={() => onApply('toFront')}
            />
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
            const op: ZOp =
                e.code === 'BracketLeft' ? (e.shiftKey ? 'toBack' : 'backward') : e.shiftKey ? 'toFront' : 'forward';
            apply(op);
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, []);
}
