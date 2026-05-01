// Filename families WebDAV must accept on PUT but hide from PROPFIND listings:
// AppleDouble (Finder), Office Windows lock files, Office temp files. Hiding
// them keeps Eigen UI listings clean while preserving client behaviour.
export function isHiddenName(name: string): boolean {
    if (name === '.DS_Store') return true;
    if (name.startsWith('._')) return true;
    if (name.startsWith('~$')) return true;
    if (/^~WRD\d{4}\.tmp$/i.test(name)) return true;
    if (/^\.~WRD/i.test(name)) return true;
    return false;
}
