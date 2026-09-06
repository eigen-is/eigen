import { domainToASCII } from 'node:url';

// Just enough RFC 8601 Authentication-Results parsing to answer one question: did OUR verifying MTA
// (OpenDKIM, `Mode sv`) record a DKIM pass whose signing domain is aligned with the sender's `From:`
// domain? Inbound iMIP acts automatically only on a verified sender; every other input is unverified.

// Fold a domain to lowercase punycode. The mail parser decodes From domains to unicode
// (`domainToUnicode`) while OpenDKIM writes `header.d` in ASCII, so both sides normalise here first.
function normalizeDomain(domain: string): string {
    const trimmed = domain.toLowerCase().replace(/\.$/, '');
    return domainToASCII(trimmed) || trimmed;
}

// The authserv-id is the first token of the header value, before the first ';' and any version number.
function authservIdOf(value: string): string {
    return value.split(';', 1)[0].trim().split(/\s+/)[0].toLowerCase();
}

// DMARC-style relaxed alignment: equal, or one is a subdomain of the other. A full organisational-domain
// (public-suffix) comparison would need the PSL; subdomain-suffix matching covers the real cases without it.
export function domainsAligned(a: string, b: string): boolean {
    const x = normalizeDomain(a);
    const y = normalizeDomain(b);
    if (!x || !y) return false;
    return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

// Each `dkim=<result>` method segment in one Authentication-Results value, with its signing domain
// (from `header.d`, else the domain part of `header.i`). One header can carry several DKIM results.
function dkimResults(value: string): { result: string; domain: string | null }[] {
    const out: { result: string; domain: string | null }[] = [];
    for (const segment of value.split(';')) {
        const result = /^\s*dkim\s*=\s*([a-z]+)/i.exec(segment);
        if (!result) continue;
        const d = /\bheader\.d\s*=\s*([^\s;()]+)/i.exec(segment);
        const i = /\bheader\.i\s*=\s*([^\s;()]+)/i.exec(segment);
        let domain = (d?.[1] ?? i?.[1] ?? null)?.toLowerCase() ?? null;
        if (domain) domain = domain.slice(domain.lastIndexOf('@') + 1);
        out.push({ result: result[1].toLowerCase(), domain });
    }
    return out;
}

// True when the topmost Authentication-Results header stamped with OUR authserv-id records a
// dkim=pass whose domain aligns with `fromDomain`. Only the topmost matching header is trusted: our
// MTA prepends its own result and strips pre-existing ones with our authserv-id (RemoveARFrom), so a
// header sitting below it is either a stale hop or an attacker's forgery, never authoritative.
export function verifyImipSender(
    authenticationResults: string[] | undefined,
    ourAuthservId: string,
    fromDomain: string | null,
): { verified: boolean; reason: string } {
    if (!fromDomain) return { verified: false, reason: 'no From address' };
    if (!authenticationResults?.length) return { verified: false, reason: 'no Authentication-Results header' };

    const ours = ourAuthservId.toLowerCase();
    const header = authenticationResults.find((value) => authservIdOf(value) === ours);
    if (!header) return { verified: false, reason: `no Authentication-Results from ${ourAuthservId}` };

    const aligned = dkimResults(header).some(
        (r) => r.result === 'pass' && r.domain !== null && domainsAligned(r.domain, fromDomain),
    );
    return aligned
        ? { verified: true, reason: 'aligned dkim=pass' }
        : { verified: false, reason: `no aligned dkim=pass for ${fromDomain}` };
}
