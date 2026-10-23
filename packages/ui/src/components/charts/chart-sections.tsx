// A selected chart's own panel sections: the chart editor's rows over its spec, then the look's paint rows. The
// host that edits one chart record (a doc's chart node, a sheet's chart) wraps them in its own panel, in the order
// the canvas panel gives a chart: its geometry before, its arrangement after. Each row hands back what the host
// writes: the next spec, or the look fields it changed.

import type { ChartLook, ChartSpec } from '@workspace/lib/types/chart';
import { parseFill, serializeFill } from '@workspace/lib/vector';
import { PaintSections } from '@workspace/ui/components/properties-panel';
import type { ReactNode } from 'react';
import { ChartEditor } from './chart-editor';

type ChartSectionsProps = {
    spec: ChartSpec;
    onChange: (spec: ChartSpec) => void;
    look: ChartLook;
    onLookChange: (patch: Partial<ChartLook>) => void;
    // The chart's data has more points than the sketch draws.
    sketchCapped: boolean;
    categories?: string[];
    seriesNames?: string[];
    onEditData?: () => void;
    // The host's rows at the end of the Chart section, where an inline chart's Edit data sits.
    children?: ReactNode;
};

export function ChartSections({
    spec,
    onChange,
    look,
    onLookChange,
    sketchCapped,
    categories,
    seriesNames,
    onEditData,
    children,
}: ChartSectionsProps) {
    return (
        <>
            <ChartEditor
                spec={spec}
                onChange={onChange}
                categories={categories}
                seriesNames={seriesNames}
                onEditData={onEditData}
            >
                {children}
            </ChartEditor>
            <PaintSections
                fill={look.fill}
                fillStyle={parseFill(look.fill).style}
                marksHatch
                strokeColor={look.strokeColor}
                strokeWidth={look.strokeWidth}
                strokeStyle={look.strokeStyle}
                strokeOptional
                roughness={look.roughness}
                color={look.color}
                sketchCapped={sketchCapped}
                onFill={(next) => onLookChange({ fill: serializeFill(next(parseFill(look.fill))) })}
                onChange={onLookChange}
            />
        </>
    );
}
