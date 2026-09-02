// Type declarations for untyped mail-related npm packages

declare module 'libmime' {
    const libmime: {
        parseHeaderValue(value: string): { value: string | false; params: Record<string, string> };
        decodeWords(value: string): string;
        decodeFlowed(text: string, delSp?: boolean): string;
        detectMimeType(filenameOrExt: string): string;
    };
    export default libmime;
}

declare module 'libqp' {
    const libqp: { decode(str: string): Buffer };
    export default libqp;
}

declare module 'html-to-text' {
    function convert(html: string, options?: Record<string, unknown>): string;

    export { convert };
}
