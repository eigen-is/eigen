// Null unless the value is a `;base64` data: URI, so a caller can fall back to reading it another way.
export function splitDataUri(value: string): { mediaType: string | null; base64: string } | null {
    if (!value.startsWith('data:')) return null;
    const comma = value.indexOf(',');
    if (comma === -1) return null;
    const header = value.slice('data:'.length, comma);
    if (!header.endsWith(';base64')) return null;
    return { mediaType: header.slice(0, -';base64'.length) || null, base64: value.slice(comma + 1) };
}
