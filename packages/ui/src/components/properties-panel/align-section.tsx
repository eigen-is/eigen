// Shared Align / distribute / match-size section for the canvas properties panels (slides + vector,
// U7a). Presentational only — the host owns the write (computeArrange → its own updateElements). Same
// two rows, labels, icons, and multi-select gating everywhere so the panels read identically.

import type { ArrangeOp } from '@workspace/lib/vector';
import {
    AlignHorizontalDistributeCenter,
    AlignHorizontalJustifyCenter,
    AlignHorizontalJustifyEnd,
    AlignHorizontalJustifyStart,
    AlignVerticalDistributeCenter,
    AlignVerticalJustifyCenter,
    AlignVerticalJustifyEnd,
    AlignVerticalJustifyStart,
    MoveHorizontal,
    MoveVertical,
} from 'lucide-react';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { PropertySection } from './properties-panel';

// `count` is the selection size — distribute needs 3+, everything else 2+ (the caller mounts this only
// for 2+ selections).
export function AlignSection({ count, onApply }: { count: number; onApply: (op: ArrangeOp) => void }) {
    const canDistribute = count >= 3;
    return (
        <PropertySection title="Align">
            <div className="flex items-center gap-1">
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyStart}
                    tooltipText="Align left"
                    onClick={() => onApply('align-left')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyCenter}
                    tooltipText="Align horizontal center"
                    onClick={() => onApply('align-h-center')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalJustifyEnd}
                    tooltipText="Align right"
                    onClick={() => onApply('align-right')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyStart}
                    tooltipText="Align top"
                    onClick={() => onApply('align-top')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyCenter}
                    tooltipText="Align vertical center"
                    onClick={() => onApply('align-v-center')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalJustifyEnd}
                    tooltipText="Align bottom"
                    onClick={() => onApply('align-bottom')}
                />
            </div>
            <div className="flex items-center gap-1">
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignHorizontalDistributeCenter}
                    tooltipText={canDistribute ? 'Distribute horizontally' : 'Select 3+ objects to distribute'}
                    disabled={!canDistribute}
                    onClick={() => onApply('distribute-h')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={AlignVerticalDistributeCenter}
                    tooltipText={canDistribute ? 'Distribute vertically' : 'Select 3+ objects to distribute'}
                    disabled={!canDistribute}
                    onClick={() => onApply('distribute-v')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={MoveHorizontal}
                    tooltipText="Match width"
                    onClick={() => onApply('match-width')}
                />
                <TooltipButton
                    className="h-7 w-7"
                    icon={MoveVertical}
                    tooltipText="Match height"
                    onClick={() => onApply('match-height')}
                />
            </div>
        </PropertySection>
    );
}
