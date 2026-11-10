// What a link to a web page may point at, for a sheet's cell link and a doc's link alike. An address may come from an
// imported file or a peer and ends up in window.open and in exported files, so it is trimmed, http, https and mailto
// pass, an address with no scheme gets https, and any other scheme, such as javascript: or data:, never resolves.

export function resolveWebLink(linkAddress: string): string | null {
    const address = linkAddress.trim();
    if (/^(https?|mailto):/i.test(address)) return address;
    // A colon followed by digits only (up to the next / or end) is a host:port like localhost:3000, not a scheme.
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(address)) return null;
    return `https://${address}`;
}

// A space anywhere between the scheme and the first /, ? or #.
const HOST_WITH_SPACE = /^[^/?#]*:\/*[^/?#]*\s/;

// The address a link dialog stores, or null when a browser could not open it. Chrome's parser escapes a space in the
// host name instead of refusing it, so that one is refused by hand.
export function webLinkHref(linkAddress: string): string | null {
    const href = resolveWebLink(linkAddress);
    if (href == null || !URL.canParse(href) || HOST_WITH_SPACE.test(href)) return null;
    return href;
}
