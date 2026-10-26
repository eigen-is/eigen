// The xlsx writer's entry: an export's sheets to the bytes of a workbook, its SpreadsheetML written by hand as the
// import reads it. Every part is declared before any is written, and a part's body is pulled when the zip writer
// reaches it, so the sheets come first, then the shared strings and the styles they filled. Runs in the transform
// process: `media` is the sheets' images as the Office media prep made them. What Excel's limits cut is counted
// through `lost`.

import type { Sheet } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_FONT } from '@workspace/lib/sheets';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { LossCounter } from '../../../document/transform/protocol';
import { THEME_TYPE, themeXml } from '../../../ooxml/drawingml';
import type { PackagePart } from '../../../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf, writePackage } from '../../../ooxml/opc';
import { SPREADSHEETML } from '../../../ooxml/spreadsheetml';
import type { OfficeMedia } from '../../office-image';
import { OFFICE_IMAGE_CONTENT_TYPES, officeImages } from '../../office-image';
import { drawingOf } from './drawing';
import { activeTabOf, sheetNames, workbookXml } from './package';
import { sharedStringTable } from './strings';
import { styleRegistry } from './styles';
import { worksheetPart } from './worksheet';

export function writeXlsx(
    sheets: Sheet[],
    { title, media, lost }: { title: string; media: OfficeMedia[]; lost: LossCounter['lost'] },
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
        title: stripEigenExtension(title),
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
