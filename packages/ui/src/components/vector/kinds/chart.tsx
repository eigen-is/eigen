// The chart's UI entry: the shared chart editor as the panel's Chart section, the Edit data dialog a
// double-click opens, Convert to shapes, and the element Insert → Chart places. Every edit is one write
// of the `chart` field, the next spec serialized whole.

import { parseChartSpec, sampleChartSpec } from '@workspace/lib/charts';
import type { ChartType } from '@workspace/lib/types/chart';
import {
    convertToShapes,
    type NewVectorElement,
    type Point,
    type StyleDefaults,
    type VectorElement,
} from '@workspace/lib/vector';
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
        chart: JSON.stringify({ ...sampleChartSpec(type), fontFamily: style.fontFamily }),
    };
}

const specOf = (el: VectorElement | undefined) => (el?.type === 'chart' ? parseChartSpec(el.chart) : null);

// One chart only: a spec doesn't merge across charts the way a color does.
export function ChartPanelSection({ elements, onChange, onReplace }: KindPanelSectionProps) {
    const [el] = elements;
    const spec = elements.length === 1 ? specOf(el) : null;
    if (!spec) return null;
    return (
        <ChartEditor spec={spec} onChange={(next) => onChange({ chart: JSON.stringify(next) })}>
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

export function ChartEditDialog({ element, onChange, onClose }: KindEditDialogProps) {
    return (
        <InlineChartDataDialog
            spec={specOf(element)}
            onSave={(next) => onChange({ chart: JSON.stringify(next) })}
            onClose={onClose}
        />
    );
}
