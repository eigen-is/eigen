import { describe, expect, test } from 'bun:test';
import { parseRouteTable, scopeTrustedNetworks } from '../../lib/auth/trusted-networks';

const HEADER = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT';

function table(...rows: string[]): string {
    return `${[HEADER, ...rows.map((row) => `${row}\t0\t0\t0`)].join('\n')}\n`;
}

// The eigen network 172.20.0.0/24 with gateway 172.20.0.1, and a second network 172.29.6.0/24 with gateway 172.29.6.1.
const DEFAULT_VIA_EIGEN = 'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000';
const EIGEN_SUBNET = 'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t00FFFFFF';
const DEFAULT_VIA_OTHER = 'eth0\t00000000\t01061DAC\t0003\t0\t0\t0\t00000000';
const OTHER_SUBNET = 'eth0\t00061DAC\t00000000\t0001\t0\t0\t0\t00FFFFFF';
const EIGEN_SUBNET_ON_ETH1 = 'eth1\t000014AC\t00000000\t0001\t0\t0\t0\t00FFFFFF';
const OTHER_SUBNET_ON_ETH1 = 'eth1\t00061DAC\t00000000\t0001\t0\t0\t0\t00FFFFFF';

const TRUSTED = ['127.0.0.0/8', '::1', '172.20.0.0/24'];

describe('parseRouteTable', () => {
    test('reads each route as dotted quads and a prefix length', () => {
        expect(parseRouteTable(table(DEFAULT_VIA_EIGEN, EIGEN_SUBNET))).toEqual([
            { iface: 'eth0', destination: '0.0.0.0', gateway: '172.20.0.1', prefix: 0 },
            { iface: 'eth0', destination: '172.20.0.0', gateway: '0.0.0.0', prefix: 24 },
        ]);
    });
});

describe('scopeTrustedNetworks', () => {
    test('leaves out the gateway of the subnet the default route leaves through', () => {
        const routes = parseRouteTable(table(DEFAULT_VIA_EIGEN, EIGEN_SUBNET));
        expect(scopeTrustedNetworks(TRUSTED, routes)).toEqual({
            networks: TRUSTED,
            gateways: ['172.20.0.1'],
            untrusted: [],
        });
    });

    test('still finds our gateway with a second network attached whose default route loses', () => {
        const routes = parseRouteTable(table(DEFAULT_VIA_EIGEN, EIGEN_SUBNET, OTHER_SUBNET_ON_ETH1));
        expect(scopeTrustedNetworks(TRUSTED, routes).gateways).toEqual(['172.20.0.1']);
    });

    test("drops the subnet when a second network's default route wins, since its gateway is unknown", () => {
        const routes = parseRouteTable(table(DEFAULT_VIA_OTHER, EIGEN_SUBNET_ON_ETH1, OTHER_SUBNET));
        expect(scopeTrustedNetworks(TRUSTED, routes)).toEqual({
            networks: ['127.0.0.0/8', '::1'],
            gateways: [],
            untrusted: ['172.20.0.0/24'],
        });
    });

    test('drops the subnet when there is no default route', () => {
        const routes = parseRouteTable(table(EIGEN_SUBNET));
        expect(scopeTrustedNetworks(TRUSTED, routes).networks).toEqual(['127.0.0.0/8', '::1']);
    });

    test('keeps every entry and excludes nothing without a route table (macOS dev)', () => {
        expect(scopeTrustedNetworks(TRUSTED, [])).toEqual({ networks: TRUSTED, gateways: [], untrusted: [] });
    });

    test('leaves out the gateway when a wider entry than its subnet holds it', () => {
        const routes = parseRouteTable(table(DEFAULT_VIA_EIGEN, EIGEN_SUBNET));
        const trusted = ['127.0.0.0/8', '172.16.0.0/12'];
        expect(scopeTrustedNetworks(trusted, routes)).toEqual({
            networks: trusted,
            gateways: ['172.20.0.1'],
            untrusted: [],
        });
    });

    test('keeps entries no route reaches directly', () => {
        const routes = parseRouteTable(table(DEFAULT_VIA_OTHER, OTHER_SUBNET));
        const trusted = ['127.0.0.0/8', '10.0.0.0/8', '10.0.0.5', '172.20.0.0/24'];
        expect(scopeTrustedNetworks(trusted, routes)).toEqual({ networks: trusted, gateways: [], untrusted: [] });
    });
});
