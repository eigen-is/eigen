import { writeZip } from '../../lib/core/zip';

// An xlsx built from raw SpreadsheetML on writeZip, so a test states exactly the XML a reader meets.

export const SML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DRAWING = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// `data` is the <sheetData> content; `xml` replaces the whole part.
export type FixtureSheet = {
    name?: string;
    state?: string;
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
    workbookPr?: string;
    // Parts written as given, past the workbook's own.
    parts?: { name: string; data: string | Uint8Array }[];
};

export const OFFICE_COLORS =
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>';

export function sheetXml({ data = '', before = '', after = '' }: FixtureSheet): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SML}" xmlns:r="${R}">${before}<sheetData>${data}</sheetData>${after}</worksheet>`;
}

export function xlsxFixture(workbook: FixtureWorkbook): Uint8Array {
    const { sheets, styles, strings, colors, workbookPr = '', parts = [] } = workbook;
    const rel = (id: string, type: string, target: string) =>
        `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`;
    const workbookRels = sheets.map((_, index) =>
        rel(`rId${index + 1}`, 'worksheet', `worksheets/sheet${index + 1}.xml`),
    );
    const files: { name: string; data: string | Uint8Array }[] = [
        {
            name: '[Content_Types].xml',
            data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
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
                        `<sheet name="${name ?? `Sheet${index + 1}`}" sheetId="${index + 1}"${state ? ` state="${state}"` : ''} r:id="rId${index + 1}"/>`,
                )
                .join('')}</sheets></workbook>`,
        },
        ...sheets.map((sheet, index) => ({
            name: `xl/worksheets/sheet${index + 1}.xml`,
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
    if (colors !== undefined) {
        workbookRels.push(rel('rIdTheme', 'theme', 'theme/theme1.xml'));
        files.push({
            name: 'xl/theme/theme1.xml',
            data: `<a:theme xmlns:a="${DRAWING}" name="Office"><a:themeElements><a:clrScheme name="Office">${colors}</a:clrScheme></a:themeElements></a:theme>`,
        });
    }
    files.push({
        name: 'xl/_rels/workbook.xml.rels',
        data: `<Relationships xmlns="${PACKAGE_RELS}">${workbookRels.join('')}</Relationships>`,
    });
    return writeZip([...files, ...parts]);
}
