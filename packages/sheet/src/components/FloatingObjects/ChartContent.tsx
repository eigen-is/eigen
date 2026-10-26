// A sheet chart's body inside its floating frame: the painter's SVG of the chart in its look, read from the workbook's
// cells. The floating-object layer renders one per chart, and a resize redraws it at the preview size.

import type { SheetChart } from '@workspace/lib/sheets';
import { sheetFloatingBox } from '@workspace/lib/sheets';
import type { Box } from '@workspace/lib/vector';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { sheetChartSvg } from '../../state';

// The painter's drawing of a chart at the frame's box, redrawn at a resize's preview size while the grip is held.
export function ChartContent({ chart, box }: { chart: SheetChart; box: Box }) {
    const { context } = useContext(WorkbookContext);
    const stored = sheetFloatingBox(chart);
    const resized = box.width !== stored.width || box.height !== stored.height;
    const svg = sheetChartSvg(context, resized ? { ...chart, width: box.width, height: box.height } : chart);
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the painter's own svg; readChartSpec checks every color and label it draws
    return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}
