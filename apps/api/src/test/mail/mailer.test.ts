import { afterEach, describe, expect, test } from 'bun:test';
import { createTransport } from '../../lib/core/mailer';

describe('createTransport', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASSWORD']) {
            const original = originalEnv[key];
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    });

    test('uses SMTP transport when SMTP_HOST is set', () => {
        process.env['SMTP_HOST'] = 'postfix';
        process.env['SMTP_PORT'] = '25';
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['host']).toBe('postfix');
        expect(opts?.['port']).toBe(25);
        expect(opts?.['secure']).toBe(false);
        expect(opts?.['auth']).toBeUndefined();
        expect(opts?.['requireTLS']).toBe(false);
        expect(opts?.['tls']).toEqual({ rejectUnauthorized: false });
    });

    test('authenticates and verifies the certificate when relay credentials are set', () => {
        process.env['SMTP_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_PORT'] = '587';
        process.env['SMTP_USER'] = 'relay-user';
        process.env['SMTP_PASSWORD'] = 'relay-secret';
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['auth']).toEqual({ user: 'relay-user', pass: 'relay-secret' });
        expect(opts?.['secure']).toBe(false);
        expect(opts?.['requireTLS']).toBe(true);
        expect(opts?.['tls']).toEqual({ rejectUnauthorized: true });
    });

    test('refuses a relay user without a password', () => {
        process.env['SMTP_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_PORT'] = '587';
        process.env['SMTP_USER'] = 'relay-user';
        delete process.env['SMTP_PASSWORD'];
        expect(() => createTransport()).toThrow('SMTP_USER is set without SMTP_PASSWORD');
    });

    test('uses implicit TLS on port 465', () => {
        process.env['SMTP_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_PORT'] = '465';
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['secure']).toBe(true);
    });

    test('SMTP_SECURE overrides the port-derived TLS mode', () => {
        process.env['SMTP_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_PORT'] = '2525';
        process.env['SMTP_SECURE'] = '1';
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['secure']).toBe(true);
    });

    test('uses sendmail transport when SMTP_HOST is not set', () => {
        delete process.env['SMTP_HOST'];
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['sendmail']).toBe(true);
    });
});
