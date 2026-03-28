export function formatFileSize(size: number) {
    if (Number.isNaN(size)) return 'unknown';
    if (size === 0) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
    const i = Math.floor(Math.log(size) / Math.log(1024));
    return `${(size / 1024 ** i).toFixed(2)} ${units[i]}`;
}
