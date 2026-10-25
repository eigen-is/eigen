// The charts a docx and a pptx write: each chart's part with its inline numbers in a workbook of its own beside it, as
// desktop Office writes one, for Word's and PowerPoint's Edit Data to open; not yet verified in desktop Office. An
// xlsx's charts name its own cells.

import { XLSX_MIME } from '@workspace/lib/constants/mime';
import type { ChartSpec } from '@workspace/lib/types/chart';
import { CHART_CONTENT_TYPE } from '../ooxml/ooxml-chart';
import type { ChartWriteOptions } from '../ooxml/ooxml-chart-writer';
import { embeddedChartSheet, writeChart } from '../ooxml/ooxml-chart-writer';
import type { PackagePart, PartRelationships } from '../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf } from '../ooxml/opc';
import type { ZipWriteEntry } from '../ooxml/zip';
import { writeXlsx } from './sheets/xlsx/to-xlsx';

// One package's charts under its folder, word or ppt: each part and its relationships, and each chart's workbook.
export type OfficeCharts = { folder: 'word' | 'ppt'; parts: PackagePart[]; files: ZipWriteEntry[] };

export function officeCharts(folder: 'word' | 'ppt'): OfficeCharts {
    return { folder, parts: [], files: [] };
}

// The workbooks' Default in [Content_Types].xml, none without a chart, so a package without one keeps its bytes.
export function officeChartContentTypes({ files }: OfficeCharts): Record<string, string> {
    return files.length > 0 ? { xlsx: XLSX_MIME } : {};
}

// The chart's part, numbered after the package's others, its workbook named as Office names one, and the r:id the
// showing part relates it by, `target` the charts folder as that part's relationships name it. Range data, which only
// a sheet can read, writes none.
export function addOfficeChart(
    charts: OfficeCharts,
    spec: ChartSpec,
    options: Pick<ChartWriteOptions, 'look' | 'frame'>,
    { target, relate }: { target: string; relate: PartRelationships['relate'] },
): string | undefined {
    const sheet = embeddedChartSheet(spec);
    if (!sheet) return undefined;
    // Every chart has its workbook, so the workbooks count the charts.
    const number = charts.files.length + 1;
    const path = `${charts.folder}/charts/chart${number}.xml`;
    const workbook = `Microsoft_Excel_Worksheet${number}.xlsx`;
    const own = partRelationships();
    const rId = own.relate('package', `../embeddings/${workbook}`);
    charts.parts.push(
        [path, writeChart(spec, { ...options, workbook: rId }), CHART_CONTENT_TYPE],
        [relsPathOf(path), relationshipsXml(own.relationships)],
    );
    charts.files.push({
        name: `${charts.folder}/embeddings/${workbook}`,
        data: writeXlsx([sheet], { title: '', media: [], warnings: [] }),
    });
    return relate('chart', `${target}chart${number}.xml`);
}
