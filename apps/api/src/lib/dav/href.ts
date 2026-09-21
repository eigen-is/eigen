// RFC 3986 § 2.2 pchar: sub-delims + ':'/'@' are legal raw in a path segment, and a reserved char's raw and %-encoded forms are NOT the same URI — so a client that PUT a raw '@' href must see '@' (never %40) in our listings, or it treats the two as different resources. encodeURIComponent over-encodes this set; un-escape it back (the sabre encodePath approach).
export function encodePathSegment(segment: string): string {
    return encodeURIComponent(segment).replace(/%(21|24|26|27|28|29|2A|2B|2C|3A|3B|3D|40)/g, decodeURIComponent);
}

// The two home collections one principal advertises; every CalDAV and CardDAV href builds on its own.
export const calendarHomeHref = (ownerId: string) => `/dav/calendars/${ownerId}/`;
export const addressbookHomeHref = (ownerId: string) => `/dav/addressbooks/${ownerId}/`;
export const principalHref = (ownerId: string) => `/dav/principals/${ownerId}/`;

export type CollectionPath = { ok: true; collection: string | null; resource: string | null } | { ok: false };

// Both routers mount one wildcard of at most two client-chosen segments, so each is percent-decoded and a third segment is a client error, not a misroute.
export function parseCollectionPath(wildcard: string): CollectionPath {
    const parts = wildcard
        .replace(/^\/+|\/+$/g, '')
        .split('/')
        .filter(Boolean);
    if (parts.length > 2) return { ok: false };
    const decoded: string[] = [];
    for (const part of parts) {
        try {
            decoded.push(decodeURIComponent(part));
        } catch {
            return { ok: false };
        }
    }
    return { ok: true, collection: decoded[0] ?? null, resource: decoded[1] ?? null };
}

// One fact for both protocols, so they cannot bound a multiget differently.
export const MULTIGET_HREF_LIMIT = 500;

// Deduped through the collection's own `keyOf`, so a client listing one resource N ways never makes us hold N copies of its bytes; the `raw:`/`uri:` prefixes keep a stored uri out of the bad-href key space.
export function resolveMultigetHrefs(
    hrefs: string[],
    prefix: string,
    keyOf: (uri: string) => string,
): { uri: string | null; href: string }[] {
    const seen = new Set<string>();
    const resolved: { uri: string | null; href: string }[] = [];
    for (const href of hrefs) {
        const normalized = href.replace(/^\/+/, '/');
        const encoded = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : '';
        let uri: string | null = null;
        if (encoded) {
            try {
                uri = decodeURIComponent(encoded);
            } catch {
                uri = null;
            }
        }
        const key = uri === null ? `raw:${href}` : `uri:${keyOf(uri)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        resolved.push({ uri, href });
    }
    return resolved;
}
