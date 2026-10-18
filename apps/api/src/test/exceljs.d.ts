// ExcelJS's types declare a global `interface Buffer extends ArrayBuffer {}` that Bun's Buffer class doesn't match, so
// `Xlsx.load` is widened for the tests that read back what the writer wrote.
import 'exceljs';

declare module 'exceljs' {
    interface Xlsx {
        load(buffer: Uint8Array | ArrayBuffer, options?: Partial<XlsxReadOptions>): Promise<Workbook>;
    }
}
