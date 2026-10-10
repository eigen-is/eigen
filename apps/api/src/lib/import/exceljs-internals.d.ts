// The range exceljs expands with, so the xlsx import counts what it will expand. The scan mirrors ExcelJS 4.4.0's parser:
// re-check it on any upgrade. A script, not a module: declared in modules.d.ts it would augment an untyped module.
declare module 'exceljs/lib/doc/range' {
    export default class Range {
        constructor(range: string);
        readonly top: number;
        readonly left: number;
        readonly bottom: number;
        readonly right: number;
    }
}
