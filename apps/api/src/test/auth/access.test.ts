import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { clientIpKey, requireLocalhost } from '../../lib/auth/access';
import { _setRouteTableForTests, isIpTrusted, parseRouteTable, readRouteTable } from '../../lib/auth/trusted-networks';

function mkRequest(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/internal/auth/verify', { method: 'POST', headers });
}

function mkServer(address: string) {
    return { requestIP: (_req: Request) => ({ address }) };
}

describe('isIpTrusted', () => {
    beforeEach(() => _setRouteTableForTests([]));

    const originalEnv = process.env['TRUSTED_NETWORKS'];

    afterEach(() => {
        if (originalEnv === undefined) delete process.env['TRUSTED_NETWORKS'];
        else process.env['TRUSTED_NETWORKS'] = originalEnv;
    });

    test('allows localhost IPs by default (no env var)', () => {
        delete process.env['TRUSTED_NETWORKS'];
        expect(isIpTrusted('127.0.0.1')).toBe(true);
        expect(isIpTrusted('::1')).toBe(true);
        expect(isIpTrusted('::ffff:127.0.0.1')).toBe(true);
    });

    test('rejects non-localhost by default', () => {
        delete process.env['TRUSTED_NETWORKS'];
        expect(isIpTrusted('192.168.1.1')).toBe(false);
        expect(isIpTrusted('172.18.0.4')).toBe(false);
    });

    test('allows Docker bridge IPs when TRUSTED_NETWORKS includes 172.16.0.0/12', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.16.0.0/12';
        expect(isIpTrusted('172.18.0.4')).toBe(true);
        expect(isIpTrusted('172.31.255.255')).toBe(true);
        expect(isIpTrusted('172.15.0.1')).toBe(false);
    });

    test('handles IPv4-mapped IPv6 addresses', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.16.0.0/12';
        expect(isIpTrusted('::ffff:172.18.0.4')).toBe(true);
        expect(isIpTrusted('::ffff:10.0.0.1')).toBe(false);
    });

    test('handles exact IP entries (no CIDR)', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.1,::1,10.0.0.5';
        expect(isIpTrusted('10.0.0.5')).toBe(true);
        expect(isIpTrusted('10.0.0.6')).toBe(false);
    });

    test('handles /8 CIDR range', () => {
        process.env['TRUSTED_NETWORKS'] = '10.0.0.0/8';
        expect(isIpTrusted('10.0.0.1')).toBe(true);
        expect(isIpTrusted('10.255.255.255')).toBe(true);
        expect(isIpTrusted('11.0.0.1')).toBe(false);
    });
});

describe('clientIpKey', () => {
    test('X-Real-IP wins over X-Forwarded-For and the socket peer', () => {
        const req = mkRequest({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
        expect(clientIpKey(req, mkServer('172.18.0.4'))).toBe('203.0.113.7');
    });

    test('falls back to the first X-Forwarded-For hop when X-Real-IP is absent', () => {
        const req = mkRequest({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
        expect(clientIpKey(req, mkServer('172.18.0.4'))).toBe('198.51.100.1');
    });

    test('falls back to the socket peer when no proxy headers are present', () => {
        expect(clientIpKey(mkRequest(), mkServer('172.18.0.4'))).toBe('172.18.0.4');
    });

    test("returns 'unknown' with no headers and no server (tests via app.handle())", () => {
        expect(clientIpKey(mkRequest(), null)).toBe('unknown');
    });
});

describe('requireLocalhost', () => {
    beforeEach(() => _setRouteTableForTests([]));

    const originalEnv = process.env['TRUSTED_NETWORKS'];

    afterEach(() => {
        if (originalEnv === undefined) delete process.env['TRUSTED_NETWORKS'];
        else process.env['TRUSTED_NETWORKS'] = originalEnv;
    });

    test('allows a bare bridge request from a trusted socket peer', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.16.0.0/12';
        expect(() => requireLocalhost(mkRequest(), mkServer('172.18.0.4'))).not.toThrow();
    });

    test('rejects a Caddy-proxied request even when it spoofs a localhost X-Real-IP', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.16.0.0/12';
        // Socket peer is the trusted bridge (Caddy); rejection is by header PRESENCE, not value.
        expect(() => requireLocalhost(mkRequest({ 'x-real-ip': '127.0.0.1' }), mkServer('172.18.0.4'))).toThrow(
            /localhost only/,
        );
    });

    test('rejects when X-Forwarded-For is present even from a trusted socket', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.16.0.0/12';
        expect(() => requireLocalhost(mkRequest({ 'x-forwarded-for': '203.0.113.9' }), mkServer('172.18.0.4'))).toThrow(
            /localhost only/,
        );
    });

    test('rejects a bare request from an untrusted socket peer', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1';
        expect(() => requireLocalhost(mkRequest(), mkServer('203.0.113.9'))).toThrow(/localhost only/);
    });

    test('allows when there is no server (tests via app.handle())', () => {
        expect(() => requireLocalhost(mkRequest(), null)).not.toThrow();
    });

    describe('behind a Docker bridge', () => {
        // The eigen network 172.20.0.0/24, its gateway 172.20.0.1 the default route.
        const ROUTES = parseRouteTable(
            [
                'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT',
                'eth0\t00000000\t010014AC\t0003\t0\t0\t0\t00000000\t0\t0\t0',
                'eth0\t000014AC\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0',
            ].join('\n'),
        );

        afterEach(() => _setRouteTableForTests(readRouteTable()));

        test('refuses the gateway, which a local user on the host arrives from', () => {
            process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,172.20.0.0/24';
            _setRouteTableForTests(ROUTES);
            expect(() => requireLocalhost(mkRequest(), mkServer('172.20.0.1'))).toThrow(/localhost only/);
            expect(() => requireLocalhost(mkRequest(), mkServer('::ffff:172.20.0.1'))).toThrow(/localhost only/);
            expect(() => requireLocalhost(mkRequest(), mkServer('172.20.0.4'))).not.toThrow();
            expect(() => requireLocalhost(mkRequest(), mkServer('127.0.0.1'))).not.toThrow();
        });
    });
});
