// The chart's UI entry: the shared chart editor as the panel's Chart section, the Edit data dialog a
// double-click opens, Convert to shapes, and the element Insert → Chart places. Every edit is a change applied
// onto the parts as stored, so a key this build doesn't know stays, and writes only the parts it changed.

import { chartSpecWrites, newChartSpecParts, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartType } from '@workspace/lib/types/chart';
import type { NewVectorElement, Point, StyleDefaults, VectorElement } from '@workspace/lib/vector';
import { convertToShapes } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { ChartEditor, InlineChartDataDialog } from '@workspace/ui/components/charts';
import { Shapes } from 'lucide-react';
import type { KindEditDialogProps, KindPanelSectionProps } from './index';

// A canvas chart's own sizes, which differ from CHART_DEFAULT_SIZE, the size of a doc's or a sheet's new chart: Google
// Drawings inserts a chart at 640 × 400, and on a 16:9 slide (1920 × 1080) a new chart fills most of it.
const NEW_CHART_SIZE = { infinite: { width: 640, height: 400 }, frame: { width: 1200, height: 675 } };

// In the host's font, which the spec carries from then on.
export function newChartElement(
    type: ChartType,
    center: Point,
    viewport: 'infinite' | 'frame',
    style: StyleDefaults,
): NewVectorElement {
    const { width, height } = NEW_CHART_SIZE[viewport];
    return {
        type: 'chart',
        x: center.x - width / 2,
        y: center.y - height / 2,
        width,
        height,
        ...newChartSpecParts(sampleChartSpec(type, style.fontFamily)),
    };
}

const readChartElementSpec = (el: VectorElement | undefined) => readChartSpec(el?.type === 'chart' ? el : {});

// One chart only: a spec doesn't merge across charts the way a color does.
export function ChartPanelSection({ elements, onChange, onReplace }: KindPanelSectionProps) {
    const [el] = elements;
    const { stored, spec } = readChartElementSpec(elements.length === 1 ? el : undefined);
    if (!spec) return null;
    return (
        <ChartEditor spec={spec} stored={stored} onChange={(change) => onChange(chartSpecWrites(stored, change))}>
            {spec.data.source === 'inline' && (
                // Laid out on the click, not on every render of the panel.
                <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                        const shapes = convertToShapes(el);
                        if (shapes.length) onReplace(shapes);
                    }}
                >
                    <Shapes /> Convert to shapes
                </Button>
            )}
        </ChartEditor>
    );
}

// Save applies onto the element as it is then, so a peer's edit while the dialog was open stays.
export function ChartEditDialog({ element, onChange, onClose }: KindEditDialogProps) {
    const { stored, spec } = readChartElementSpec(element);
    return (
        <InlineChartDataDialog
            spec={spec}
            stored={stored}
            onSave={(change) => onChange(chartSpecWrites(stored, change))}
            onClose={onClose}
        />
    );
}
