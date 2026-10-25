import type { Sheet } from '@workspace/lib/sheets';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { TransformWarning } from '../../../document/transform/protocol';
import { lossCounter } from '../../../document/transform/protocol';
import type { OfficeMedia } from '../../office-image';
import { writeWorkbook } from './package';

// Sheet[] -> XLSX workbook bytes, the SpreadsheetML written by hand as the import reads it. Runs in the transform
// process (child.ts owns execution, export-document.ts the orchestration), so it never reaches the Mount: `media` is the
// sheets' images as the Office media prep made them. What Excel's limits cut is counted in `warnings`.
export function writeXlsx(
    sheets: Sheet[],
    { title, media, warnings }: { title: string; media: OfficeMedia[]; warnings: TransformWarning[] },
): Uint8Array {
    const losses = lossCounter();
    const bytes = writeWorkbook(sheets, stripEigenExtension(title), media, losses.lost);
    warnings.push(...losses.warnings());
    return bytes;
}
