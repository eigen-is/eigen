import { afterEach, describe, expect, test } from 'bun:test';
import { isIpTrusted } from '../lib/core/access';

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
