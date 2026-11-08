// The workbook part: the sheets' names as Excel takes them, the tab Excel opens on, and workbook.xml, which lists the
// sheets and their filters.

import type { Sheet } from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { legalSheetNames, quoteSheetName, rangeToA1 } from '@workspace/sheet/engine';
import type { Lost } from '../../../document/transform/protocol';
import { R_NS, SML_NS } from '../../../ooxml/ooxml';
import { filterArea } from './worksheet';

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

// Excel keeps History for itself, and each name a sheet changes for it is counted. Formulas naming a repaired sheet keep
// the name they had.
export function sheetNames(sheets: Pick<Sheet, 'name'>[], lost: Lost): string[] {
    const written = legalSheetNames(
        sheets.map(({ name }) => name),
        ['History'],
    );
    for (const [index, { name }] of sheets.entries()) if (written[index] !== name) lost('sheet-names-changed');
    return written;
}
