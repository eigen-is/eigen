// The chart parts the Office writers add, one rule for the xlsx, docx and pptx writers: each chart as its own part,
// numbered in its package, and the r:id the part that shows it relates it by. A docx's or pptx's chart keeps its
// numbers in a workbook of its own beside the part, as desktop Office writes one, for Word's and PowerPoint's Edit
// Data. An xlsx's chart names the workbook's own cells. What a chart part can't hold is counted here.

import { XLSX_MIME } from '@workspace/lib/constants/mime';
import type { ChartSpec } from '@workspace/lib/types/chart';
import type { Lost } from '../document/transform/protocol';
import { CHART_CONTENT_TYPE } from '../ooxml/ooxml-chart';
import type { ChartWriteOptions } from '../ooxml/ooxml-chart-writer';
import { chartLookSimplified, embeddedChartSheet, writeChart } from '../ooxml/ooxml-chart-writer';
import type { PackagePart, PartRelationships } from '../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf } from '../ooxml/opc';
import type { ZipWriteEntry } from '../ooxml/zip';
import { writeXlsx } from './sheets/xlsx/to-xlsx';

// The charts one package writes under its folder. Each part is named `name` and its number. `parts` are the chart
// parts, with their relationships in a docx or a pptx, and `workbooks` the workbooks those charts embed.
export type OfficeCharts = {
    folder: 'word' | 'ppt' | 'xl';
    name: string;
    count: number;
    parts: PackagePart[];
    workbooks: ZipWriteEntry[];
};

export function officeCharts(folder: OfficeCharts['folder'], name = 'chart'): OfficeCharts {
    return { folder, name, count: 0, parts: [], workbooks: [] };
}

// The workbooks' Default in [Content_Types].xml. A package without a workbook declares none, so it keeps its bytes.
export function officeChartContentTypes({ workbooks }: OfficeCharts): Record<string, string> {
    return workbooks.length > 0 ? { xlsx: XLSX_MIME } : {};
}

// The part that shows the chart: `target` is the charts folder as that part's relationships name it, and `layer` the
// turn and the fade a host draws the chart with, which no chart part carries.
type ChartHost = {
    target: string;
    relate: PartRelationships['relate'];
    lost: Lost;
    layer?: { angle: number; opacity: number };
};

// Adds the chart's part and returns the r:id the host relates it by. A spec that doesn't parse writes nothing and is
// counted as a chart left out. So is range data outside an xlsx, since only a workbook has the cells it names. A chart
// drawn plainer than Eigen draws it is counted as simplified.
export function addOfficeChart(
    charts: OfficeCharts,
    spec: ChartSpec | null,
    options: Omit<ChartWriteOptions, 'workbook'>,
    { target, relate, lost, layer }: ChartHost,
): string | undefined {
    const embedded = charts.folder !== 'xl';
    const sheet = spec && embedded ? embeddedChartSheet(spec) : undefined;
    if (!spec || (embedded && !sheet)) {
        lost('charts-dropped');
        return undefined;
    }
    if (chartLookSimplified(options.look, layer)) lost('charts-simplified');
    const file = `${charts.name}${++charts.count}.xml`;
    const path = `${charts.folder}/charts/${file}`;
    if (!sheet) {
        charts.parts.push([path, writeChart(spec, options), CHART_CONTENT_TYPE]);
        return relate('chart', `${target}${file}`);
    }
    const workbook = `Microsoft_Excel_Worksheet${charts.count}.xlsx`;
    const own = partRelationships();
    const rId = own.relate('package', `../embeddings/${workbook}`);
    charts.parts.push(
        [path, writeChart(spec, { ...options, workbook: rId }), CHART_CONTENT_TYPE],
        [relsPathOf(path), relationshipsXml(own.relationships)],
    );
    charts.workbooks.push({
        name: `${charts.folder}/embeddings/${workbook}`,
        // A chart's own sheet holds only its names and numbers, so writing it leaves nothing out.
        data: writeXlsx([sheet], { title: '', media: [], lost: () => {} }),
    });
    return relate('chart', `${target}${file}`);
}
