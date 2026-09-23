import { describe, expect, test } from 'bun:test';
import MailComposer from 'nodemailer/lib/mail-composer';
import { getOrgName } from '../../lib/config/server-config';
import { buildMailOptions, createTransport, onBehalfOf } from '../../lib/core/mailer';
import { restoreEnvAfterEach } from '../env-test-helpers';

// nodemailer's Transporter type does not surface the resolved options the factory built, so the
// suite reads them through this one cast.
function transportOptions(transport: ReturnType<typeof createTransport>): Record<string, unknown> {
    return (transport as unknown as { options: Record<string, unknown> }).options;
}

describe('createTransport', () => {
    restoreEnvAfterEach([
        'MAIL_ENABLED',
        'SMTP_HOST',
        'SMTP_PORT',
        'SMTP_RELAY_HOST',
        'SMTP_RELAY_PORT',
        'SMTP_RELAY_USER',
        'SMTP_RELAY_PASSWORD',
    ]);

    const relay = (port: string, user?: string, password?: string) => {
        process.env['MAIL_ENABLED'] = '0';
        process.env['SMTP_RELAY_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_RELAY_PORT'] = port;
        if (user === undefined) delete process.env['SMTP_RELAY_USER'];
        else process.env['SMTP_RELAY_USER'] = user;
        if (password === undefined) delete process.env['SMTP_RELAY_PASSWORD'];
        else process.env['SMTP_RELAY_PASSWORD'] = password;
    };

    test('hosting mail, it hands mail to postfix anonymously, whatever relay Postfix itself uses', () => {
        process.env['MAIL_ENABLED'] = '1';
        process.env['SMTP_HOST'] = 'postfix';
        process.env['SMTP_PORT'] = '25';
        process.env['SMTP_RELAY_HOST'] = 'smtp-relay.brevo.com';
        process.env['SMTP_RELAY_USER'] = 'relay-user';
        process.env['SMTP_RELAY_PASSWORD'] = 'relay-secret';
        const opts = transportOptions(createTransport());
        expect(opts['host']).toBe('postfix');
        expect(opts['port']).toBe(25);
        expect(opts['secure']).toBe(false);
        expect(opts['auth']).toBeUndefined();
        expect(opts['requireTLS']).toBe(false);
        expect(opts['tls']).toEqual({ rejectUnauthorized: false });
    });

    test('without hosted mail it sends through the relay, and verifies the certificate once it authenticates', () => {
        relay('587', 'relay-user', 'relay-secret');
        const opts = transportOptions(createTransport());
        expect(opts['host']).toBe('smtp-relay.brevo.com');
        expect(opts['port']).toBe(587);
        expect(opts['auth']).toEqual({ user: 'relay-user', pass: 'relay-secret' });
        expect(opts['secure']).toBe(false);
        expect(opts['requireTLS']).toBe(true);
        expect(opts['tls']).toEqual({ rejectUnauthorized: true });
    });

    test('an anonymous relay keeps opportunistic TLS', () => {
        relay('1025');
        const opts = transportOptions(createTransport());
        expect(opts['auth']).toBeUndefined();
        expect(opts['requireTLS']).toBe(false);
        expect(opts['tls']).toEqual({ rejectUnauthorized: false });
    });

    test('refuses a relay user without a password', () => {
        relay('587', 'relay-user');
        expect(() => createTransport()).toThrow('SMTP_RELAY_USER is set without SMTP_RELAY_PASSWORD');
    });

    test('uses implicit TLS on port 465', () => {
        relay('465');
        expect(transportOptions(createTransport())['secure']).toBe(true);
    });

    test('uses sendmail when there is no server to hand mail to', () => {
        process.env['MAIL_ENABLED'] = '0';
        delete process.env['SMTP_RELAY_HOST'];
        process.env['SMTP_HOST'] = 'postfix';
        expect(transportOptions(createTransport())['sendmail']).toBe(true);
    });
});

describe('the system sender', () => {
    restoreEnvAfterEach(['SMTP_FROM', 'MAIL_DOMAIN']);

    const systemFrom = () => buildMailOptions({ to: [], subject: 's', text: 't' }).from;

    test('without SMTP_FROM it is the org name at noreply@ the mail domain', () => {
        delete process.env['SMTP_FROM'];
        process.env['MAIL_DOMAIN'] = 'example.org';
        expect(systemFrom()).toEqual({ name: getOrgName(), address: 'noreply@example.org' });
    });

    test('SMTP_FROM as Name <address> sets both', () => {
        process.env['SMTP_FROM'] = 'Acme Mail <eigen@acme.nl>';
        expect(systemFrom()).toEqual({ name: 'Acme Mail', address: 'eigen@acme.nl' });
    });

    test('a bare SMTP_FROM address keeps the org name', () => {
        process.env['SMTP_FROM'] = 'eigen@acme.nl';
        expect(systemFrom()).toEqual({ name: getOrgName(), address: 'eigen@acme.nl' });
    });
});

describe('onBehalfOf', () => {
    restoreEnvAfterEach(['SMTP_FROM', 'MAIL_DOMAIN', 'MAIL_ENABLED']);

    const via = { from: { name: 'Alice via Acme', address: 'eigen@acme.nl' } };

    const setup = (mailEnabled: boolean) => {
        process.env['SMTP_FROM'] = 'Acme <eigen@acme.nl>';
        process.env['MAIL_DOMAIN'] = 'acme.nl';
        process.env['MAIL_ENABLED'] = mailEnabled ? '1' : '0';
    };

    test('an external address goes out from the system sender and replies reach the user', () => {
        setup(true);
        const user = { name: 'Alice', address: 'alice@gmail.com' };
        expect(onBehalfOf(user)).toEqual({ ...via, replyTo: user });
    });

    test('with mail off a local address also goes out from the system sender', () => {
        setup(false);
        const user = { name: 'Alice', address: 'alice@acme.nl' };
        expect(onBehalfOf(user)).toEqual({ ...via, replyTo: user });
    });

    test('a local address with mail on sends as the user, with no Reply-To', () => {
        setup(true);
        const user = { name: 'Alice', address: 'alice@acme.nl' };
        expect(onBehalfOf(user)).toEqual({ from: user });
    });

    test('a user without a name is named by address', () => {
        setup(true);
        expect(onBehalfOf({ name: '', address: 'alice@gmail.com' }).from?.name).toBe('alice@gmail.com via Acme');
    });

    test('the SMTP envelope sender follows From, and Reply-To lands in the headers', async () => {
        setup(true);
        const options = buildMailOptions({
            ...onBehalfOf({ name: 'Alice', address: 'alice@gmail.com' }),
            to: [{ name: '', address: 'bob@example.com' }],
            subject: 's',
            text: 't',
        });
        const node = new MailComposer(options).compile();
        expect(node.getEnvelope().from).toBe('eigen@acme.nl');
        const raw = (await node.build()).toString();
        expect(raw).toContain('From: Alice via Acme <eigen@acme.nl>');
        expect(raw).toContain('Reply-To: Alice <alice@gmail.com>');
    });
});
