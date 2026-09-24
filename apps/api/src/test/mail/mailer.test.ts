import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import MailComposer from 'nodemailer/lib/mail-composer';
import { getOrgName } from '../../lib/config/server-config';
import { updateServerSettings } from '../../lib/config/server-settings';
import { buildMailOptions, createTransport } from '../../lib/core/mailer';
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
    restoreEnvAfterEach(['MAIL_DOMAIN']);
    afterEach(() => updateServerSettings({ mail: { senderName: '', senderAddress: '' } }));

    const systemFrom = () => buildMailOptions({ to: [], subject: 's', text: 't' }).from;

    test('unnamed, it is the org name at noreply@ the mail domain', () => {
        process.env['MAIL_DOMAIN'] = 'example.org';
        expect(systemFrom()).toEqual({ name: getOrgName(), address: 'noreply@example.org' });
    });

    test('the admin names it in the server settings', async () => {
        await updateServerSettings({ mail: { senderName: 'Acme Mail', senderAddress: 'eigen@acme.nl' } });
        expect(systemFrom()).toEqual({ name: 'Acme Mail', address: 'eigen@acme.nl' });
    });

    test('an address alone keeps the org name', async () => {
        await updateServerSettings({ mail: { senderAddress: 'eigen@acme.nl' } });
        expect(systemFrom()).toEqual({ name: getOrgName(), address: 'eigen@acme.nl' });
    });
});

describe('mail from a person', () => {
    restoreEnvAfterEach(['MAIL_DOMAIN', 'MAIL_ENABLED']);
    beforeEach(() => updateServerSettings({ mail: { senderAddress: 'eigen@acme.nl' } }));
    afterEach(() => updateServerSettings({ mail: { senderAddress: '', relaySendsAsUsers: false } }));

    const setup = (mailEnabled: boolean, relaySendsAsUsers = false) => {
        process.env['MAIL_DOMAIN'] = 'acme.nl';
        process.env['MAIL_ENABLED'] = mailEnabled ? '1' : '0';
        return updateServerSettings({ mail: { relaySendsAsUsers } });
    };
    const optionsFrom = (address: string, name = 'Alice') =>
        buildMailOptions({
            from: { name, address },
            to: [{ name: '', address: 'bob@example.com' }],
            subject: 's',
            text: 't',
            envelope: { to: ['bob@example.com'] },
        });
    const via = (address: string) => ({
        from: { name: `Alice via ${getOrgName()}`, address: 'eigen@acme.nl' },
        replyTo: { name: 'Alice', address },
        envelope: { from: 'eigen@acme.nl', to: ['bob@example.com'] },
    });
    const own = (address: string) => ({
        from: { name: 'Alice', address },
        envelope: { from: address, to: ['bob@example.com'] },
    });

    test('with hosted mail, an address on the mail domain sends as itself', async () => {
        await setup(true);
        const options = optionsFrom('alice@acme.nl');
        expect(options).toMatchObject(own('alice@acme.nl'));
        expect('replyTo' in options).toBe(false);
    });

    test('with hosted mail, an outside address goes out via the system sender', async () => {
        await setup(true);
        expect(optionsFrom('alice@gmail.com')).toMatchObject(via('alice@gmail.com'));
    });

    test('through a relay that takes the mail domain, an address on it sends as itself', async () => {
        await setup(false, true);
        const options = optionsFrom('alice@acme.nl');
        expect(options).toMatchObject(own('alice@acme.nl'));
        expect('replyTo' in options).toBe(false);
    });

    test('through a relay that takes only the system sender, every address goes out via it', async () => {
        await setup(false);
        expect(optionsFrom('alice@acme.nl')).toMatchObject(via('alice@acme.nl'));
        await setup(false, true);
        expect(optionsFrom('alice@gmail.com')).toMatchObject(via('alice@gmail.com'));
    });

    test('a person without a name is named by address', async () => {
        await setup(true);
        expect(optionsFrom('alice@gmail.com', '').from).toEqual({
            name: `alice@gmail.com via ${getOrgName()}`,
            address: 'eigen@acme.nl',
        });
    });

    test('without a per-copy envelope, the SMTP sender follows From and Reply-To lands in the headers', async () => {
        await setup(true);
        const options = buildMailOptions({
            from: { name: 'Alice', address: 'alice@gmail.com' },
            to: [{ name: '', address: 'bob@example.com' }],
            subject: 's',
            text: 't',
        });
        const node = new MailComposer(options).compile();
        expect(node.getEnvelope().from).toBe('eigen@acme.nl');
        const raw = (await node.build()).toString();
        expect(raw).toContain(`From: Alice via ${getOrgName()} <eigen@acme.nl>`);
        expect(raw).toContain('Reply-To: Alice <alice@gmail.com>');
    });
});
