// ExcelJS's bundled types declare `interface Buffer extends ArrayBuffer {}` at global
// scope, which conflicts with Bun/Node's class-based Buffer. Widen `Xlsx.load` through
// interface augmentation so we can call it with Uint8Array/ArrayBuffer without a cast.
import 'exceljs';
import type { XlsxCfRule, XlsxDataValidation } from './sheets/from-xlsx';

declare module 'exceljs' {
    interface Xlsx {
        load(buffer: Uint8Array | ArrayBuffer, options?: Partial<XlsxReadOptions>): Promise<Workbook>;
    }

    // Real Worksheet properties (lib/doc/worksheet.js) that exceljs's typings omit.
    interface Worksheet {
        conditionalFormattings?: { ref: string; rules: XlsxCfRule[] }[];
        dataValidations?: { model?: Record<string, XlsxDataValidation> };
    }
}
