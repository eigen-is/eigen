import type { Sheet } from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { writeZip } from '../../lib/core/zip';
import { sheetsToXlsx } from '../../lib/export/sheets/to-xlsx';

// An xlsx built from raw SpreadsheetML on writeZip, so a test states exactly the XML a reader meets.

export const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// `data` is the <sheetData> content; `xml` replaces the whole part. A chart sheet is xl/chartsheets/sheetN.xml, a
// <chartsheet> of `before` and `after`.
export type FixtureSheet = {
    name?: string;
    state?: string;
    chartSheet?: boolean;
    data?: string;
    before?: string;
    after?: string;
    xml?: string;
};

export type FixtureWorkbook = {
    sheets: FixtureSheet[];
    // The <styleSheet> content.
    styles?: string;
    // Each <si>'s content, or the whole part.
    strings?: string[] | string;
    // The <a:clrScheme> content.
    colors?: string;
    // The whole theme part, where a test needs its namespace or prefix; wins over `colors`.
    theme?: string;
    workbookPr?: string;
    // [Content_Types].xml's entries past the workbook's own.
    types?: string;
    // Parts written as given, past the workbook's own.
    parts?: { name: string; data: string | Uint8Array }[];
};

export const OFFICE_COLORS =
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';

// A cell's value: text is inline, a formula carries its cached result as Excel writes it (none when left out), `rich`
// is the <si> content of runs.
export type FixtureValue =
    | string
    | number
    | boolean
    | { formula: string; result?: string | number | boolean }
    | { rich: string };

// [A1 reference, value, cellXfs index]; a cell without a value is a styled blank.
export type FixtureCell = [ref: string, value?: FixtureValue, style?: number];

function columnOf(ref: string): number {
    let column = 0;
    for (const letter of ref.replace(/\d/g, '')) column = column * 26 + letter.charCodeAt(0) - 64;
    return column;
}

function cellXml([ref, value, style]: FixtureCell): string {
    const s = style === undefined ? '' : ` s="${style}"`;
    const text = (string: string) => `<is><t xml:space="preserve">${escapeXml(string)}</t></is>`;
    if (value === undefined) return `<c r="${ref}"${s}/>`;
    if (typeof value === 'string') return `<c r="${ref}"${s} t="inlineStr">${text(value)}</c>`;
    if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
    if (typeof value === 'boolean') return `<c r="${ref}"${s} t="b"><v>${value ? 1 : 0}</v></c>`;
    if ('rich' in value) return `<c r="${ref}"${s} t="inlineStr"><is>${value.rich}</is></c>`;
    const { formula, result } = value;
    const f = `<f>${escapeXml(formula)}</f>`;
    if (result === undefined) return `<c r="${ref}"${s}>${f}</c>`;
    if (typeof result === 'number') return `<c r="${ref}"${s}>${f}<v>${result}</v></c>`;
    if (typeof result === 'boolean') return `<c r="${ref}"${s} t="b">${f}<v>${result ? 1 : 0}</v></c>`;
    return `<c r="${ref}"${s} t="str">${f}<v>${escapeXml(result)}</v></c>`;
}

// <sheetData> content from cells in any order; `rowAttrs` adds attributes to a row, and a row named there without cells
// is written bare, as Excel writes a hidden empty row.
export function rowsXml(cells: FixtureCell[], rowAttrs: Record<number, string> = {}): string {
    const rows = new Map<number, FixtureCell[]>();
    for (const row of Object.keys(rowAttrs)) rows.set(Number(row), []);
    for (const cell of cells) {
        const row = Number(cell[0].replace(/\D/g, ''));
        rows.set(row, [...(rows.get(row) ?? []), cell]);
    }
    return [...rows]
        .sort(([a], [b]) => a - b)
        .map(([row, entries]) => {
            const attrs = rowAttrs[row] ? ` ${rowAttrs[row]}` : '';
            const inner = entries
                .sort((a, b) => columnOf(a[0]) - columnOf(b[0]))
                .map(cellXml)
                .join('');
            return inner ? `<row r="${row}"${attrs}>${inner}</row>` : `<row r="${row}"${attrs}/>`;
        })
        .join('');
}

// A sheet's relationships part holding external hyperlinks as rId1, rId2, ... in the order given.
export function linkRels(sheet: number, targets: string[]): { name: string; data: string } {
    const links = targets.map(
        (target, index) =>
            `<Relationship Id="rId${index + 1}" Type="${R}/hyperlink" Target="${escapeXml(target)}" TargetMode="External"/>`,
    );
    return {
        name: `xl/worksheets/_rels/sheet${sheet}.xml.rels`,
        data: `<Relationships xmlns="${PACKAGE_RELS}">${links.join('')}</Relationships>`,
    };
}

export type FixtureStyles = {
    // numFmtId (from 164) → formatCode.
    numFmts?: Record<number, string>;
    fonts?: string[];
    fills?: string[];
    borders?: string[];
    xfs?: string[];
    dxfs?: string[];
};

// The <styleSheet> content with what Excel writes first: Calibri 11 as font 0, the none and gray125 fills, an empty
// border and a plain xf, so the first font, border and xf a test gives is index 1 and the first fill index 2.
export function styleSheet({ numFmts = {}, fonts = [], fills = [], borders = [], xfs = [], dxfs = [] }: FixtureStyles) {
    const list = (tag: string, item: string[]) => `<${tag} count="${item.length}">${item.join('')}</${tag}>`;
    const formats = Object.entries(numFmts).map(
        ([id, code]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`,
    );
    return [
        formats.length ? list('numFmts', formats) : '',
        list('fonts', [
            '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font>',
            ...fonts,
        ]),
        list('fills', [
            '<fill><patternFill patternType="none"/></fill>',
            '<fill><patternFill patternType="gray125"/></fill>',
            ...fills,
        ]),
        list('borders', ['<border><left/><right/><top/><bottom/><diagonal/></border>', ...borders]),
        list('cellXfs', ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>', ...xfs]),
        dxfs.length ? list('dxfs', dxfs) : '',
    ].join('');
}

export function sheetXml({ data = '', before = '', after = '', chartSheet }: FixtureSheet): string {
    if (chartSheet) return `<chartsheet xmlns="${SML}" xmlns:r="${R}">${before}${after}</chartsheet>`;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="${R}">${before}<sheetData>${data}</sheetData>${after}</worksheet>`;
}

export function xlsxFixture(workbook: FixtureWorkbook): Uint8Array {
    const { sheets, styles, strings, colors, theme, workbookPr = '', types = '', parts = [] } = workbook;
    const rel = (id: string, type: string, target: string) =>
        `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
    const pathOf = ({ chartSheet }: FixtureSheet, index: number) =>
        `${chartSheet ? 'chartsheets' : 'worksheets'}/sheet${index + 1}.xml`;
    const workbookRels = sheets.map((sheet, index) =>
        rel(`rId${index + 1}`, sheet.chartSheet ? 'chartsheet' : 'worksheet', pathOf(sheet, index)),
    );
    const files: { name: string; data: string | Uint8Array }[] = [
        {
            name: '[Content_Types].xml',
            data: `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${types}</Types>`,
        },
        {
            name: '_rels/.rels',
            data: `<Relationships xmlns="${PACKAGE_RELS}">${rel('rId1', 'officeDocument', 'xl/workbook.xml')}</Relationships>`,
        },
        {
            name: 'xl/workbook.xml',
            data: `<workbook xmlns="${SML}" xmlns:r="${R}">${workbookPr}<sheets>${sheets
                .map(
                    ({ name, state }, index) =>
                        `<sheet name="${escapeXml(name ?? `Sheet${index + 1}`)}" sheetId="${index + 1}"${state ? ` state="${state}"` : ''} r:id="rId${index + 1}"/>`,
                )
                .join('')}</sheets></workbook>`,
        },
        ...sheets.map((sheet, index) => ({
            name: `xl/${pathOf(sheet, index)}`,
            data: sheet.xml ?? sheetXml(sheet),
        })),
    ];
    if (styles !== undefined) {
        workbookRels.push(rel('rIdStyles', 'styles', 'styles.xml'));
        files.push({ name: 'xl/styles.xml', data: `<styleSheet xmlns="${SML}">${styles}</styleSheet>` });
    }
    if (strings !== undefined) {
        workbookRels.push(rel('rIdStrings', 'sharedStrings', 'sharedStrings.xml'));
        const data =
            typeof strings === 'string'
                ? strings
                : `<sst xmlns="${SML}">${strings.map((string) => `<si>${string}</si>`).join('')}</sst>`;
        files.push({ name: 'xl/sharedStrings.xml', data });
    }
    if (theme !== undefined || colors !== undefined) {
        workbookRels.push(rel('rIdTheme', 'theme', 'theme/theme1.xml'));
        files.push({
            name: 'xl/theme/theme1.xml',
            data:
                theme ??
                `<a:theme xmlns:a="${DRAWING}" name="Office"><a:themeElements><a:clrScheme name="Office">${colors}</a:clrScheme></a:themeElements></a:theme>`,
        });
    }
    files.push({
        name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships xmlns="${PACKAGE_RELS}">${workbookRels.join('')}</Relationships>`,
    });
    return writeZip([...files, ...parts]);
}

// The xlsx export as the transform calls it: untitled, without media, its warnings kept where a test passes them.
export function exportXlsx(sheets: Sheet[], options: Partial<Parameters<typeof sheetsToXlsx>[1]> = {}): Uint8Array {
    return sheetsToXlsx(sheets, { title: '', warnings: [], media: [], ...options });
}
