// A sheet chart's body inside its floating frame: the painter's SVG of the chart in its look, read from the workbook's
// cells. The floating-object layer renders one per chart, and a resize scales the drawing until the grip lets go.

import type { SheetChart } from '@workspace/lib/sheets';
import { sheetFloatingBox } from '@workspace/lib/sheets';
import type { Box } from '@workspace/lib/vector';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { sheetChartSvg } from '../../state';

// The painter's drawing of a chart at its stored size. A sketched chart is slow to draw when it is large, so while
// the grip is held the drawing is scaled to the preview box, text included. The resize's commit draws it once at the
// new size.
export function ChartContent({ chart, box }: { chart: SheetChart; box: Box }) {
    const { context } = useContext(WorkbookContext);
    const { width, height } = sheetFloatingBox(chart);
    const resized = box.width !== width || box.height !== height;
    const scale = { transform: `scale(${box.width / width}, ${box.height / height})`, transformOrigin: '0 0' };
    return (
        <div
            style={resized ? scale : undefined}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: the painter's own svg; readChartSpec checks every color and label it draws
            dangerouslySetInnerHTML={{ __html: sheetChartSvg(context, chart) }}
        />
    );
}
