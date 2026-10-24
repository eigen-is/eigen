import type { Sheet } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_FONT } from '@workspace/lib/sheets';
import { escapeXml, stripNonXmlChars } from '@workspace/lib/xml';
import { MAX_SHEET_NAME_LENGTH, quoteSheetName, rangeToA1, SHEET_NAME_FORBIDDEN } from '@workspace/sheet/engine';
import type { CountedWarningCode } from '../../../document/transform/protocol';
import { THEME_TYPE, themeXml } from '../../../ooxml/drawingml';
import { R_NS, SML_NS } from '../../../ooxml/ooxml';
import type { PackagePart } from '../../../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf, writePackage } from '../../../ooxml/opc';
import { SPREADSHEETML } from '../../../ooxml/spreadsheetml';
import type { OfficeMedia } from '../../office-image';
import { OFFICE_IMAGE_CONTENT_TYPES, officeImages } from '../../office-image';
import { drawingOf } from './drawing';
import { sharedStringTable } from './strings';
import { styleRegistry } from './styles';
import { filterArea, worksheetPart } from './worksheet';

// The workbook as a package: the sheets' names, workbook.xml and its relationships, and every part declared before any
// is written. A part's body is pulled when the zip writer reaches it, so the sheets come first, then the shared strings
// and the styles they filled.

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
    const pictures = officeImages(media, 'xl/media');
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
        if (drawing) parts.push(...drawing.parts);
    }
    const workbook = partRelationships();
    const ids = sheets.map((_, index) => workbook.relate('worksheet', `worksheets/sheet${index + 1}.xml`));
    for (const type of ['sharedStrings', 'styles']) workbook.relate(type, `${type}.xml`);
    workbook.relate('theme', 'theme/theme1.xml');
    return writePackage({
        main: 'xl/workbook.xml',
        title,
        defaults: pictures.files.length > 0 ? OFFICE_IMAGE_CONTENT_TYPES : {},
        parts: [
            ['xl/workbook.xml', workbookXml(sheets, names, ids, active), `${SPREADSHEETML}.sheet.main+xml`],
            ['xl/_rels/workbook.xml.rels', relationshipsXml(workbook.relationships)],
            ...parts,
            ['xl/sharedStrings.xml', () => strings.xml(), `${SPREADSHEETML}.sharedStrings+xml`],
            ['xl/styles.xml', () => [styles.xml()], `${SPREADSHEETML}.styles+xml`],
            ['xl/theme/theme1.xml', themeXml(SHEET_DEFAULT_FONT.name), THEME_TYPE],
        ],
        files: pictures.files,
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

// The workbook's sheets by their relationship ids, the hidden ones hidden, each filtered sheet's hidden filter database
// name, which Excel writes beside its autoFilter, and the calculation Excel last saved with.
export function workbookXml(sheets: Sheet[], names: string[], ids: string[], active: number): string {
    const entries = sheets.map(
        (sheet, index) =>
            `<sheet name="${escapeXml(names[index])}" sheetId="${index + 1}"${sheet.hide === 1 && index !== active ? ' state="hidden"' : ''} r:id="${ids[index]}"/>`,
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
