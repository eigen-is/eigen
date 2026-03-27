export function contentDisposition(type: 'attachment' | 'inline', fileName: string): string {
    const ascii = fileName.replace(/[^\x20-\x7E]/g, '_');
    const encoded = encodeURIComponent(fileName);
    if (ascii === fileName) {
        return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"`;
    }
    return `${type}; filename="${ascii.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encoded}`;
}
