// Works out which client IPs the TRUSTED_NETWORKS list really trusts. It reads the Linux route table to
// find the bridge subnets this host sits on. A subnet's gateway is not trusted, because a client of a
// published port can arrive from it, and a subnet whose gateway is unknown is not trusted at all.
// requireLocalhost asks isIpTrusted before it lets a caller in.

import { existsSync, readFileSync } from 'node:fs';

export type Route = { iface: string; destination: string; gateway: string; prefix: number };

export type TrustedNetworks = { networks: string[]; gateways: string[]; untrusted: string[] };

const DEFAULT_TRUSTED = '127.0.0.0/8,::1';
const ROUTE_TABLE = '/proc/net/route';

// Read on first use rather than at import, so a module that only needs a guard reads no route table.
let routes: Route[] | null = null;
let trust: (TrustedNetworks & { source: string }) | null = null;

export function isIpTrusted(ip: string): boolean {
    return isTrustedBy(trustedNetworks(), ip);
}

export function isTrustedBy({ networks, gateways }: TrustedNetworks, ip: string): boolean {
    return !gateways.includes(normalizeIp(ip)) && networks.some((entry) => matchesCidr(ip, entry));
}

// A subnet's gateway is the default route's only when that route leaves through the subnet's interface. An entry
// no subnet route matches is kept, since exact IPs and wider entries must stay.
export function scopeTrustedNetworks(networks: string[], routes: Route[]): TrustedNetworks {
    const defaultRoute = routes.find((route) => route.destination === '0.0.0.0' && route.prefix === 0);
    const untrusted: string[] = [];
    for (const network of networks) {
        const subnet = routes.find(
            (route) => route.gateway === '0.0.0.0' && `${route.destination}/${route.prefix}` === network,
        );
        if (!subnet) continue;
        if (defaultRoute?.iface !== subnet.iface) untrusted.push(network);
    }
    const kept = networks.filter((network) => !untrusted.includes(network));
    // A wider entry than the subnet holding the gateway trusts it too.
    const gateways =
        defaultRoute && kept.some((entry) => matchesCidr(defaultRoute.gateway, entry)) ? [defaultRoute.gateway] : [];
    return { networks: kept, gateways, untrusted };
}

export function parseRouteTable(text: string): Route[] {
    return text
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        .filter((fields) => fields.length >= 8)
        .map(([iface, destination, gateway, , , , , mask]) => ({
            iface,
            destination: hexToIpv4(destination),
            gateway: hexToIpv4(gateway),
            prefix: [...parseInt(mask, 16).toString(2)].filter((bit) => bit === '1').length,
        }));
}

function trustedNetworks(): TrustedNetworks {
    const source = process.env['TRUSTED_NETWORKS'] || DEFAULT_TRUSTED;
    if (trust?.source !== source) {
        const entries = source.split(',').map((entry) => entry.trim());
        // None outside Linux (macOS dev), where nothing is excluded.
        routes ??= existsSync(ROUTE_TABLE) ? parseRouteTable(readFileSync(ROUTE_TABLE, 'utf8')) : [];
        trust = { source, ...scopeTrustedNetworks(entries, routes) };
        for (const network of trust.untrusted) {
            console.warn(
                `TRUSTED_NETWORKS: the default route does not leave through ${network}, so its gateway is unknown; not trusting it`,
            );
        }
    }
    return trust;
}

function matchesCidr(ip: string, entry: string): boolean {
    const normalized = normalizeIp(ip);

    if (!entry.includes('/')) return normalized === entry || ip === entry;

    const [network, prefixStr] = entry.split('/');
    const prefix = parseInt(prefixStr, 10);
    // IPv4 only, which covers the Docker bridges and loopback.
    if (!network.includes('.') || !normalized.includes('.')) return false;

    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (ipv4ToNumber(normalized) & mask) === (ipv4ToNumber(network) & mask);
}

function normalizeIp(ip: string): string {
    return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

// The kernel writes each address as little-endian hex.
function hexToIpv4(hex: string): string {
    return [6, 4, 2, 0].map((at) => parseInt(hex.slice(at, at + 2), 16)).join('.');
}

function ipv4ToNumber(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}
