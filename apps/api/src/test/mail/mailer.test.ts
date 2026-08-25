import { afterEach, describe, expect, test } from 'bun:test';
import { createTransport } from '../../lib/core/mailer';

describe('createTransport', () => {
    const originalHost = process.env['SMTP_HOST'];
    const originalPort = process.env['SMTP_PORT'];

    afterEach(() => {
        if (originalHost === undefined) delete process.env['SMTP_HOST'];
        else process.env['SMTP_HOST'] = originalHost;
        if (originalPort === undefined) delete process.env['SMTP_PORT'];
        else process.env['SMTP_PORT'] = originalPort;
    });

    test('uses SMTP transport when SMTP_HOST is set', () => {
        process.env['SMTP_HOST'] = 'postfix';
        process.env['SMTP_PORT'] = '25';
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['host']).toBe('postfix');
        expect(opts?.['port']).toBe(25);
    });

    test('uses sendmail transport when SMTP_HOST is not set', () => {
        delete process.env['SMTP_HOST'];
        const transport = createTransport();
        const opts = (transport as unknown as { options: Record<string, unknown> }).options;
        expect(opts?.['sendmail']).toBe(true);
    });
});
