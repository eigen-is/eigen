// Scheme allowlist for webpage hyperlink targets. linkAddress may come straight
// from an untrusted xlsx import and flows into window.open (FE navigation,
// state/modules/hyperlink.ts) as well as exported xlsx/HTML link targets:
// http/https/mailto pass through verbatim, a scheme-less address gets https://
// prepended, and any other scheme (javascript:, data:, file:, …) refuses to
// resolve so scripting schemes can never navigate.
export function resolveWebLink(linkAddress: string): string | null {
    if (/^(https?|mailto):/i.test(linkAddress)) return linkAddress;
    // A colon followed by digits only (up to the next / or end) is a host:port
    // like localhost:3000, not a scheme — let it fall through to the prepend.
    if (/^[a-z][a-z0-9+.-]*:(?!\d+(?:\/|$))/i.test(linkAddress)) return null;
    return `https://${linkAddress}`;
}
