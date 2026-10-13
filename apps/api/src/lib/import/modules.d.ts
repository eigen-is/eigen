// ExcelJS's bundled types declare `interface Buffer extends ArrayBuffer {}` at global
// scope, which conflicts with Bun/Node's class-based Buffer. Widen `Xlsx.load` through
// interface augmentation so the export tests can read what the writer wrote from a
// Uint8Array without a cast.
import 'exceljs';

declare module 'exceljs' {
    interface Xlsx {
        load(buffer: Uint8Array | ArrayBuffer, options?: Partial<XlsxReadOptions>): Promise<Workbook>;
    }
}
