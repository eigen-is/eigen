// Download image for a chart a doc or a sheet holds: the chart item its copy writes, drawn by the canvas image writer
// as the chart element a canvas paste makes of it, on white and named for its title.

import { onMutationError } from '@workspace/lib/api-error';
import type { EigenClipboardChartItem } from '@workspace/lib/types/clipboard';
import { chartImageName } from '@workspace/lib/vector';
import { downloadCanvasImage } from '../vector/canvas-image';

export function downloadChartImage(item: EigenClipboardChartItem): void {
    downloadCanvasImage(item, { name: chartImageName(item.parts) }).catch(onMutationError);
}
