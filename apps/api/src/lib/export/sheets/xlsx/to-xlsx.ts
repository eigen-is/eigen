// The xlsx writer's entry: an export's sheets to the bytes of a workbook, run in the transform process.

import type { Sheet } from '@workspace/lib/sheets';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { LossCounter } from '../../../document/transform/protocol';
import type { OfficeMedia } from '../../office-image';
import { writeWorkbook } from './package';

// Sheet[] -> XLSX workbook bytes, the SpreadsheetML written by hand as the import reads it. Runs in the transform
// process (child.ts owns execution, export-document.ts the orchestration), so it never reaches the Mount: `media` is the
// sheets' images as the Office media prep made them. What Excel's limits cut is counted through `lost`.
export function writeXlsx(
    sheets: Sheet[],
    { title, media, lost }: { title: string; media: OfficeMedia[]; lost: LossCounter['lost'] },
): Uint8Array {
    return writeWorkbook(sheets, stripEigenExtension(title), media, lost);
}
