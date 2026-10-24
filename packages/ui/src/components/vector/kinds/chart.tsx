// The chart's UI entry: the shared chart editor as the panel's Chart section, the Edit data dialog a
// double-click opens, Convert to shapes, and the element Insert → Chart places. Every edit is a change applied
// onto the `chart` field as stored, so a key this build doesn't know stays, and written as that one field.

import { applyChartSpecChange, readChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartSpecChange, ChartType, StoredChartSpec } from '@workspace/lib/types/chart';
import type { NewVectorElement, Point, StyleDefaults, VectorElement } from '@workspace/lib/vector';
import { convertToShapes } from '@workspace/lib/vector';
import { Button } from '@workspace/ui/components/button';
import { ChartEditor, InlineChartDataDialog } from '@workspace/ui/components/charts';
import { Shapes } from 'lucide-react';
import type { KindEditDialogProps, KindPanelSectionProps } from './index';

// Google's defaults: a drawing's chart, and a chart filling most of a 16:9 slide (1920 × 1080).
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
        chart: JSON.stringify(sampleChartSpec(type, style.fontFamily)),
    };
}

const chartOf = (el: VectorElement | undefined) => readChartSpec(el?.type === 'chart' ? el.chart : '');
const write = (stored: StoredChartSpec, change: ChartSpecChange) => ({
    chart: JSON.stringify(applyChartSpecChange(stored, change)),
});

// One chart only: a spec doesn't merge across charts the way a color does.
export function ChartPanelSection({ elements, onChange, onReplace }: KindPanelSectionProps) {
    const [el] = elements;
    const { stored, spec } = chartOf(elements.length === 1 ? el : undefined);
    if (!spec) return null;
    return (
        <ChartEditor spec={spec} stored={stored} onChange={(change) => onChange(write(stored, change))}>
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
    const { stored, spec } = chartOf(element);
    return (
        <InlineChartDataDialog
            spec={spec}
            stored={stored}
            onSave={(change) => onChange(write(stored, change))}
            onClose={onClose}
        />
    );
}
