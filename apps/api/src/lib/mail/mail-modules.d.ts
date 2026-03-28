// Type declarations for untyped mail-related npm packages

declare module 'libmime' {

    class Libmime {
        constructor(config?: { Iconv?: unknown });
        decodeHeader(line: string): { value?: string; params?: Record<string, string> } | null;
        parseHeaderValue(value: string): { value: string; params: Record<string, string> };
        buildHeaderValue(structured: { value: string; params: Record<string, string> }): string;
        decodeWords(value: string): string;
        foldLines(line: string, lineLength: number, afterSpace: boolean): string;
        decodeFlowed(text: string, delSp?: boolean): string;
        detectMimeType(filenameOrExt: string): string;
    }

    const libmime: {
        Libmime: typeof Libmime;
        detectMimeType(filenameOrExt: string): string;
    };
    export default libmime;
}

declare module 'libqp' {
    import type { Transform } from 'node:stream';
    class Decoder extends Transform {}
    class Encoder extends Transform {}
    const libqp: { Decoder: typeof Decoder; Encoder: typeof Encoder };
    export default libqp;
}

declare module 'libbase64' {
    import type { Transform } from 'node:stream';
    class Decoder extends Transform {}
    class Encoder extends Transform {}
    const libbase64: { Decoder: typeof Decoder; Encoder: typeof Encoder };
    export default libbase64;
}

declare module 'nodemailer/lib/addressparser' {
    type ParsedAddress = {
        address?: string;
        name: string;
        group?: ParsedAddress[];
    };
    function addressparser(address: string): ParsedAddress[];
    export default addressparser;
}

declare module 'encoding-japanese' {
    type ConvertOptions = {
        to: string;
        from: string;
        type?: string;
    };
    const encodingJapanese: {
        convert(data: Buffer | Uint8Array, options: ConvertOptions): string | number[];
    };
    export default encodingJapanese;
}

declare module 'punycode.js' {
    const punycode: {
        toUnicode(domain: string): string;
        toASCII(domain: string): string;
    };
    export default punycode;
}

declare module 'html-to-text' {
    function htmlToText(html: string, options?: Record<string, unknown>): string;
    export { htmlToText };
}

declare module 'tlds' {
    const tlds: string[];
    export default tlds;
}
