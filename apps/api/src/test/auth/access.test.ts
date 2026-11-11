import { afterEach, describe, expect, test } from 'bun:test';
import { clientIpKey, requireLocalhost } from '../../lib/auth/access';
import { isIpTrusted } from '../../lib/auth/trusted-networks';

// No network here is a subnet a host sits on or holds a host's gateway, so the route table of the machine running
// the tests excludes none of them.

function mkRequest(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/internal/auth/verify', { method: 'POST', headers });
}

function mkServer(address: string) {
    return { requestIP: (_req: Request) => ({ address }) };
}

describe('isIpTrusted', () => {
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
        expect(isIpTrusted('192.0.2.1')).toBe(false);
        expect(isIpTrusted('198.18.0.4')).toBe(false);
    });

    test('allows the IPs of a /12 in TRUSTED_NETWORKS', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,198.16.0.0/12';
        expect(isIpTrusted('198.18.0.4')).toBe(true);
        expect(isIpTrusted('198.31.255.255')).toBe(true);
        expect(isIpTrusted('198.15.0.1')).toBe(false);
    });

    test('handles IPv4-mapped IPv6 addresses', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,198.16.0.0/12';
        expect(isIpTrusted('::ffff:198.18.0.4')).toBe(true);
        expect(isIpTrusted('::ffff:203.0.113.1')).toBe(false);
    });

    test('handles exact IP entries (no CIDR)', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.1,::1,192.0.2.5';
        expect(isIpTrusted('192.0.2.5')).toBe(true);
        expect(isIpTrusted('192.0.2.6')).toBe(false);
    });

    test('handles /8 CIDR range', () => {
        process.env['TRUSTED_NETWORKS'] = '203.0.0.0/8';
        expect(isIpTrusted('203.0.113.1')).toBe(true);
        expect(isIpTrusted('203.255.255.255')).toBe(true);
        expect(isIpTrusted('204.0.0.1')).toBe(false);
    });
});

describe('clientIpKey', () => {
    test('X-Real-IP wins over X-Forwarded-For and the socket peer', () => {
        const req = mkRequest({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
        expect(clientIpKey(req, mkServer('198.18.0.4'))).toBe('203.0.113.7');
    });

    test('falls back to the first X-Forwarded-For hop when X-Real-IP is absent', () => {
        const req = mkRequest({ 'x-forwarded-for': '198.51.100.1, 10.0.0.1' });
        expect(clientIpKey(req, mkServer('198.18.0.4'))).toBe('198.51.100.1');
    });

    test('falls back to the socket peer when no proxy headers are present', () => {
        expect(clientIpKey(mkRequest(), mkServer('198.18.0.4'))).toBe('198.18.0.4');
    });

    test("returns 'unknown' with no headers and no server (tests via app.handle())", () => {
        expect(clientIpKey(mkRequest(), null)).toBe('unknown');
    });
});

describe('requireLocalhost', () => {
    const originalEnv = process.env['TRUSTED_NETWORKS'];

    afterEach(() => {
        if (originalEnv === undefined) delete process.env['TRUSTED_NETWORKS'];
        else process.env['TRUSTED_NETWORKS'] = originalEnv;
    });

    test('allows a bare bridge request from a trusted socket peer', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,198.16.0.0/12';
        expect(() => requireLocalhost(mkRequest(), mkServer('198.18.0.4'))).not.toThrow();
    });

    test('rejects a Caddy-proxied request even when it spoofs a localhost X-Real-IP', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,198.16.0.0/12';
        // Socket peer is the trusted bridge (Caddy); rejection is by header PRESENCE, not value.
        expect(() => requireLocalhost(mkRequest({ 'x-real-ip': '127.0.0.1' }), mkServer('198.18.0.4'))).toThrow(
            /localhost only/,
        );
    });

    test('rejects when X-Forwarded-For is present even from a trusted socket', () => {
        process.env['TRUSTED_NETWORKS'] = '127.0.0.0/8,::1,198.16.0.0/12';
        expect(() => requireLocalhost(mkRequest({ 'x-forwarded-for': '203.0.113.9' }), mkServer('198.18.0.4'))).toThrow(
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
});
