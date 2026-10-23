import { parseChartSpec } from '@workspace/lib/charts';
import { downloadBlob } from '@workspace/lib/download';
import { type SheetChart, sheetFloatingBox } from '@workspace/lib/sheets';
import type { Box } from '@workspace/lib/vector';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Download } from 'lucide-react';
import { useContext } from 'react';
import { WorkbookContext } from '../../context';
import { sheetChartSvg } from '../../state';

// The painter's drawing of a chart at the frame's box, redrawn at a resize's preview size while the grip is held.
export function ChartContent({ chart, box }: { chart: SheetChart; box: Box }) {
    const { context } = useContext(WorkbookContext);
    const stored = sheetFloatingBox(chart);
    const resized = box.width !== stored.width || box.height !== stored.height;
    const svg = sheetChartSvg(context, resized ? { ...chart, width: box.width, height: box.height } : chart);
    // biome-ignore lint/security/noDangerouslySetInnerHtml: the painter's own svg; parseChartSpec checks every color and label it draws
    return <div dangerouslySetInnerHTML={{ __html: svg }} />;
}

// White as the export draws it. The labels name Inter without embedding it: the font files are bundled into the
// server's export only.
export function DownloadChartMenuItem({ chart }: { chart: SheetChart }) {
    const { context } = useContext(WorkbookContext);
    const download = () => {
        const title = parseChartSpec(chart.spec)?.title;
        const svg = sheetChartSvg(context, chart);
        const white = svg.replace(/^<svg[^>]*>/, (open) => `${open}<rect width="100%" height="100%" fill="#fff"/>`);
        downloadBlob(new Blob([white], { type: 'image/svg+xml' }), `${title || 'Chart'}.svg`);
    };
    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger>
                <Download className="h-4 w-4" /> Download chart
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
                <DropdownMenuItem onClick={download}>SVG (.svg)</DropdownMenuItem>
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
