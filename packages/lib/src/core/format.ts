// Bytes as base64, for the `data:` URIs both the clipboard and the vCard preview build. btoa over a
// chunked binary string, not Buffer: this runs in the browser as well as in the bun test runtime.
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const CHUNK = 0x8000; // stay well under the spread arg-count limit
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

export function formatFileSize(size: number): string {
    if (Number.isNaN(size)) return 'unknown';
    if (size === 0) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return `${(size / 1024 ** i).toFixed(2)} ${units[i]}`;
}
