// The range exceljs expands with, so the xlsx import counts what it will expand.
declare module 'exceljs/lib/doc/range' {
    export default class Range {
        constructor(range: string);
        readonly top: number;
        readonly left: number;
        readonly bottom: number;
        readonly right: number;
    }
}
