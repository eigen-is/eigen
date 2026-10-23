import { SHEET_DEFAULT_FONT, type Sheet } from '@workspace/lib/sheets';
import { escapeXml, stripNonXmlChars } from '@workspace/lib/xml';
import { quoteSheetName, rangeToA1 } from '@workspace/sheet/engine';
import { THEME_TYPE, themeXml } from '../../../core/drawingml';
import { R_NS, SML_NS } from '../../../core/ooxml';
import { type PackagePart, type Relationship, relationshipsXml, relsPathOf, writePackage } from '../../../core/opc';
import type { ZipWriteEntry } from '../../../core/zip';
import { MAX_SHEET_NAME_LENGTH, SHEET_NAME_FORBIDDEN } from '../../../document/spreadsheetml';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import { OFFICE_IMAGE_CONTENT_TYPES, type OfficeMedia } from '../../office-image';
import { drawingOf, type WorkbookPictures } from './drawing';
import { sharedStringTable } from './strings';
import { styleRegistry } from './styles';
import { filterArea, worksheetPart } from './worksheet';

// The workbook as a package: the sheets' names, workbook.xml and its relationships, and every part declared before any
// is written. A part's body is pulled when the zip writer reaches it, so the sheets come first, then the shared strings
// and the styles they filled.

const SPREADSHEETML = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

export function writeWorkbook(
    sheets: Sheet[],
    title: string,
    media: OfficeMedia[],
    lost: (code: CountedWarningCode) => void,
): Uint8Array {
    const names = sheetNames(sheets, lost);
    const active = activeTabOf(sheets);
    const written = new Map<string, string>();
    for (const [index, { name }] of sheets.entries()) if (!written.has(name)) written.set(name, names[index]);
    // A chart's refs name its sheets as the workbook writes them.
    const named = sheets.map((sheet, index) =>
        sheet.name === names[index] ? sheet : { ...sheet, name: names[index] },
    );
    const styles = styleRegistry(lost);
    const strings = sharedStringTable(lost);
    const parts: PackagePart[] = [];
    const files: ZipWriteEntry[] = [];
    const pictures: WorkbookPictures = { media: new Map(media.map((item) => [item.name, item])), parts: new Map() };
    for (const [index, sheet] of sheets.entries()) {
        const path = `xl/worksheets/sheet${index + 1}.xml`;
        const drawing = drawingOf(named[index], index + 1, named, pictures, lost);
        const part = worksheetPart(sheet, {
            name: names[index],
            names: written,
            selected: index === active,
            // The drawing's part name, as the sheet's relationship targets it from xl/worksheets/.
            drawing: drawing?.path.replace(/^xl\//, '../'),
            styles,
            strings,
            lost,
        });
        parts.push([path, part.xml, `${SPREADSHEETML}.worksheet+xml`]);
        if (part.relationships.length > 0) parts.push([relsPathOf(path), relationshipsXml(part.relationships)]);
        if (drawing) {
            parts.push(...drawing.parts);
            files.push(...drawing.files);
        }
    }
    const relationships: Relationship[] = [
        ...sheets.map((_, index) => ({ type: `${R_NS}/worksheet`, target: `worksheets/sheet${index + 1}.xml` })),
        { type: `${R_NS}/sharedStrings`, target: 'sharedStrings.xml' },
        { type: `${R_NS}/styles`, target: 'styles.xml' },
        { type: `${R_NS}/theme`, target: 'theme/theme1.xml' },
    ];
    return writePackage({
        main: 'xl/workbook.xml',
        title,
        defaults: files.length > 0 ? OFFICE_IMAGE_CONTENT_TYPES : {},
        parts: [
            ['xl/workbook.xml', workbookXml(sheets, names, active), `${SPREADSHEETML}.sheet.main+xml`],
            ['xl/_rels/workbook.xml.rels', relationshipsXml(relationships)],
            ...parts,
            ['xl/sharedStrings.xml', () => strings.xml(), `${SPREADSHEETML}.sharedStrings+xml`],
            ['xl/styles.xml', () => [styles.xml()], `${SPREADSHEETML}.styles+xml`],
            ['xl/theme/theme1.xml', themeXml(SHEET_DEFAULT_FONT.name), THEME_TYPE],
        ],
        files,
    });
}

// Excel opens on the active tab, the first unless told, so a hidden first sheet would open hidden. Excel refuses to hide
// every sheet: then the first is the active tab, shown, as the import shows it.
export function activeTabOf(sheets: Pick<Sheet, 'hide'>[]): number {
    return Math.max(
        sheets.findIndex((sheet) => sheet.hide !== 1),
        0,
    );
}

// The workbook's sheets, the hidden ones hidden, each filtered sheet's hidden filter database name, which Excel writes
// beside its autoFilter, and the calculation Excel last saved with.
export function workbookXml(sheets: Sheet[], names: string[], active: number): string {
    const entries = sheets.map(
        (sheet, index) =>
            `<sheet name="${escapeXml(names[index])}" sheetId="${index + 1}"${sheet.hide === 1 && index !== active ? ' state="hidden"' : ''} r:id="rId${index + 1}"/>`,
    );
    const filters = sheets.flatMap((sheet, index) => {
        const area = filterArea(sheet);
        return area
            ? [
                  `<definedName name="_xlnm._FilterDatabase" localSheetId="${index}" hidden="1">${escapeXml(`${quoteSheetName(names[index])}!${rangeToA1(area, true)}`)}</definedName>`,
              ]
            : [];
    });
    return [
        `<workbook xmlns="${SML_NS}" xmlns:r="${R_NS}">`,
        '<workbookPr/>',
        `<bookViews><workbookView activeTab="${active}"/></bookViews>`,
        `<sheets>${entries.join('')}</sheets>`,
        filters.length > 0 ? `<definedNames>${filters.join('')}</definedNames>` : '',
        '<calcPr calcId="171027"/>',
        '</workbook>',
    ].join('');
}

// Excel refuses a name past 31 characters, holding \ / ? * [ ] :, starting or ending with a quote, empty, History, or
// one another sheet holds in any case. A name it takes is kept, the first of a name keeping it; any other is repaired
// and, when that clashes, numbered as Excel numbers a copy, past every name the workbook holds. Formulas naming a
// repaired sheet keep the name they had.
export function sheetNames(sheets: Pick<Sheet, 'name'>[], lost: (code: CountedWarningCode) => void): string[] {
    const taken = new Set(['history']);
    const kept = sheets.map(({ name }) => {
        if (name !== legalName(name) || taken.has(name.toLowerCase())) return undefined;
        taken.add(name.toLowerCase());
        return name;
    });
    return kept.map((name, index) => {
        if (name !== undefined) return name;
        lost('sheet-names-changed');
        const base = legalName(sheets[index].name) || `Sheet${index + 1}`;
        let candidate = base;
        for (let copy = 2; taken.has(candidate.toLowerCase()); copy++) {
            const suffix = ` (${copy})`;
            candidate = `${cut(base, MAX_SHEET_NAME_LENGTH - suffix.length)}${suffix}`;
        }
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

function legalName(name: string): string {
    const replaced = stripNonXmlChars(name).replace(SHEET_NAME_FORBIDDEN, '_');
    return cut(replaced, MAX_SHEET_NAME_LENGTH).replace(/^'+|'+$/g, '');
}

// Never between a surrogate pair's halves.
function cut(text: string, length: number): string {
    if (text.length <= length) return text;
    const code = text.charCodeAt(length - 1);
    return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
