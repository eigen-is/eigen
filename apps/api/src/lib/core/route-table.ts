import { existsSync, readFileSync } from 'node:fs';

export type Route = { iface: string; destination: string; gateway: string; prefix: number };

export type TrustedNetworks = { networks: string[]; gateways: string[]; untrusted: string[] };

const ROUTE_TABLE = '/proc/net/route';

// The kernel writes each address as little-endian hex.
function hexToIpv4(hex: string): string {
    return [6, 4, 2, 0].map((at) => parseInt(hex.slice(at, at + 2), 16)).join('.');
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

// None outside Linux (macOS dev), where nothing is excluded.
export function readRouteTable(): Route[] {
    return existsSync(ROUTE_TABLE) ? parseRouteTable(readFileSync(ROUTE_TABLE, 'utf8')) : [];
}

// A client of a published port can arrive from a bridge subnet's gateway (the host, Docker Desktop, rootless
// Docker), so a trusted subnet this host sits on is trusted without it. Its gateway is the default route's when
// that route leaves through the subnet's interface, as in docker/postfix/entrypoint.sh; otherwise, as when a
// second network's default route wins, it is unknown and the subnet is not trusted at all.
export function scopeTrustedNetworks(networks: string[], routes: Route[]): TrustedNetworks {
    const defaultRoute = routes.find((route) => route.destination === '0.0.0.0' && route.prefix === 0);
    const gateways: string[] = [];
    const untrusted: string[] = [];
    for (const network of networks) {
        const subnet = routes.find(
            (route) => route.gateway === '0.0.0.0' && `${route.destination}/${route.prefix}` === network,
        );
        if (!subnet) continue;
        if (defaultRoute?.iface === subnet.iface) gateways.push(defaultRoute.gateway);
        else untrusted.push(network);
    }
    return { networks: networks.filter((network) => !untrusted.includes(network)), gateways, untrusted };
}
