// Type declarations for untyped export-related npm packages

declare module '@turbodocx/html-to-docx' {
    function htmlToDocx(
        html: string,
        headerHtml?: string,
        options?: {
            title?: string;
            margins?: { top?: number; right?: number; bottom?: number; left?: number };
        },
    ): Promise<ArrayBuffer>;
    export default htmlToDocx;
}
