// The decoder exceljs expands ranges with, so the xlsx import counts what it will expand.
declare module 'exceljs/lib/utils/col-cache' {
    const colCache: {
        decodeEx(value: string): { top: number; left: number; bottom: number; right: number } | { top?: undefined };
    };
    export default colCache;
}
