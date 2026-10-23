import type { Sheet } from '@workspace/lib/sheets';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { CountedWarningCode, TransformWarning } from '../../document/transform/protocol';
import { writeWorkbook } from './xlsx/package';

// Sheet[] -> XLSX workbook bytes, the SpreadsheetML written by hand as the import reads it. Runs in the transform
// process (child.ts owns execution, export-document.ts the orchestration), so it never reaches the Mount. What Excel's
// limits cut is counted in `warnings`.
export async function sheetsToXlsx(
    sheets: Sheet[],
    { title = '', warnings = [] }: { title?: string; warnings?: TransformWarning[] } = {},
): Promise<Uint8Array> {
    const losses = new Map<CountedWarningCode, number>();
    const bytes = writeWorkbook(sheets, stripEigenExtension(title), (code) =>
        losses.set(code, (losses.get(code) ?? 0) + 1),
    );
    for (const [code, count] of losses) warnings.push({ code, count });
    return bytes;
}
