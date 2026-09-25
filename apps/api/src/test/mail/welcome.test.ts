import { describe, expect, test } from 'bun:test';
import { welcomeMail } from '../../lib/mail/welcome';
import { restoreEnvAfterEach } from '../env-test-helpers';

describe('welcomeMail', () => {
    restoreEnvAfterEach(['MAIL_ENABLED']);

    test('builds the message for a new Maildir while mail is hosted here', async () => {
        delete process.env['MAIL_ENABLED'];
        const welcome = await welcomeMail('Alice', 'alice@test.eigen.is');
        expect(welcome?.toString()).toContain('To: Alice <alice@test.eigen.is>');
    });

    test('writes nothing when this server hosts no mailboxes', async () => {
        process.env['MAIL_ENABLED'] = '0';
        expect(await welcomeMail('Alice', 'alice@test.eigen.is')).toBeNull();
    });
});
