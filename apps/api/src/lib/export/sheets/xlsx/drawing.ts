import type { Sheet } from '@workspace/lib/sheets';
import type { PackagePart } from '../../../core/opc';
import type { ZipWriteEntry } from '../../../core/zip';
import type { CountedWarningCode } from '../../../document/transform/protocol';

// A sheet's floating charts and pictures as its drawing part: the path its <drawing> relationship targets, the parts the
// drawing adds to the package (itself, its relationships and its charts) and its media files.
export type SheetDrawing = { path: string; parts: PackagePart[]; files: ZipWriteEntry[] };

// The workbook's sheets resolve a chart's ranges; `number` names the sheet's drawing and chart parts. Undefined when the
// sheet floats nothing.
export function drawingOf(
    _sheet: Sheet,
    _number: number,
    _sheets: Sheet[],
    _lost: (code: CountedWarningCode) => void,
): SheetDrawing | undefined {
    return undefined;
}
