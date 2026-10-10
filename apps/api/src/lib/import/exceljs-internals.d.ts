// The decoder and the defined-name reader exceljs expands ranges with, so the xlsx import counts what it will expand.
declare module 'exceljs/lib/utils/col-cache' {
    const colCache: {
        decodeEx(value: string): { top: number; left: number; bottom: number; right: number } | { top?: undefined };
    };
    export default colCache;
}

declare module 'exceljs/lib/xlsx/xform/book/defined-name-xform' {
    export default class DefinedNameXform {
        model: { ranges: string[] };
        parseOpen(node: { name: string; attributes: Record<string, string> }): boolean;
        parseText(text: string): void;
        parseClose(): boolean;
    }
}
