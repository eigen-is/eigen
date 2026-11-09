// The allowlist of schemes for a web link's target. A stored address may come straight from an xlsx import or a peer,
// and flows into window.open and exported xlsx and HTML link targets: http, https and mailto pass as written, an address
// with no scheme gets https://, and any other scheme, such as javascript:, data: or file:, resolves to nothing so a
// script can never navigate.

export function resolveWebLink(address: string): string | null {
    if (/^(https?|mailto):/i.test(address)) return address;
    // A colon followed by digits only, up to the next / or the end, is a host and port such as localhost:3000.
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(address)) return null;
    return `https://${address}`;
}
