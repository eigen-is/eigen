// Reads a data: URI, such as a pasted image's src or a vCard's inline photo: whether a value is one, the media type it
// names and its base64 payload. The callers decode the bytes themselves.

// A URI scheme matches in any case (RFC 3986), so `DATA:` is one too.
export function isDataUri(value: string): boolean {
    return /^data:/i.test(value);
}

// The media type comes bare and lower-case, without the `;charset=utf-8` a web copy adds. Null when the value is no
// data: URI or names no media type.
export function dataUriMediaType(value: string): string | null {
    const comma = value.indexOf(',');
    if (!isDataUri(value) || comma === -1) return null;
    return value.slice('data:'.length, comma).split(';')[0].trim().toLowerCase() || null;
}

// Null unless the value is a `;base64` data: URI, so a caller can fall back to reading it another way. The `;base64`
// marker matches in any case.
export function splitDataUri(value: string): { mediaType: string | null; base64: string } | null {
    const comma = value.indexOf(',');
    if (!isDataUri(value) || comma === -1 || !/;base64$/i.test(value.slice(0, comma))) return null;
    return { mediaType: dataUriMediaType(value), base64: value.slice(comma + 1) };
}
