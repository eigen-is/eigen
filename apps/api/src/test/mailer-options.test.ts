import { describe, expect, test } from 'bun:test';
import type { AttachmentReference } from '@workspace/lib/types/drive-reference';
import type { EmailDraft } from '@workspace/lib/types/mail';
import { renderAttachmentLinksText } from '../lib/core/mail-template';
import { buildMailOptions, composeRfc822, type OutboundMail } from '../lib/core/mailer';
import { draftToOutboundMail } from '../lib/mail/sender';

const base: OutboundMail = { to: [{ name: '', address: 'a@x.com' }], subject: 's', text: 't' };

describe('buildMailOptions', () => {
    test('maps envelope, messageId and threading headers', () => {
        const opts = buildMailOptions({
            ...base,
            messageId: '<id-1@localhost>',
            inReplyTo: '<parent@x.com>',
            references: ['<r1@x.com>', '<r2@x.com>'],
            envelope: { from: 'me@localhost', to: ['a@x.com'] },
        });
        expect(opts.messageId).toBe('<id-1@localhost>');
        expect(opts.inReplyTo).toBe('<parent@x.com>');
        expect(opts.references).toEqual(['<r1@x.com>', '<r2@x.com>']);
        expect(opts.envelope).toEqual({ from: 'me@localhost', to: ['a@x.com'] });
    });
    test('omits the keys when unset (other callsites unchanged)', () => {
        const opts = buildMailOptions(base);
        expect('envelope' in opts).toBe(false);
        expect('messageId' in opts).toBe(false);
    });
});

describe('composeRfc822 with pinned Message-ID', () => {
    test('raw MIME carries the pinned Message-ID and no Bcc header', async () => {
        const raw = (
            await composeRfc822({
                ...base,
                messageId: '<id-1@localhost>',
                bcc: [{ name: '', address: 'hidden@x.com' }],
            })
        ).toString();
        expect(raw).toContain('Message-ID: <id-1@localhost>');
        expect(raw).not.toContain('hidden@x.com');
    });
});

describe('renderAttachmentLinksText', () => {
    const docRef: AttachmentReference = {
        type: 'reference',
        ownerId: 'owner-1',
        mountId: 'mount-1',
        id: 'doc-1',
        name: 'Quarterly Plan.eigendoc',
        driveType: 'doc',
        mimeType: 'application/eigendoc',
    };

    test('external recipient gets a per-line email prefill and the stripped doc name', () => {
        const text = renderAttachmentLinksText([docRef], 'ext@x.com'); // preload sets domain test.eigen.is
        expect(text).toStartWith('\n\n');
        expect(text).toContain('Quarterly Plan:');
        expect(text).not.toContain('.eigendoc');
        expect(text).toContain('?email=ext%40x.com');
    });

    test('internal recipient sees the bare URL, no email prefill', () => {
        const text = renderAttachmentLinksText([docRef], 'bob@test.eigen.is');
        expect(text).toContain('Quarterly Plan:');
        expect(text).not.toContain('?email=');
    });

    test('empty references produce an empty string', () => {
        expect(renderAttachmentLinksText([])).toBe('');
    });
});

describe('draftToOutboundMail', () => {
    test('flattens groups, threads reply headers, pins messageId', () => {
        const draft = {
            id: 'draft-1',
            subject: 's',
            text: 't',
            to: { value: [{ name: 'Team', group: [{ name: 'A', address: 'a@x.com' }] }], html: '', text: '' },
            inReplyTo: '<parent@x.com>',
            references: '<r1@x.com>',
        } as unknown as EmailDraft;
        const out = draftToOutboundMail(draft, 'me@localhost');
        expect(out.to).toEqual([{ name: 'A', address: 'a@x.com' }]);
        expect(out.inReplyTo).toBe('<parent@x.com>');
        expect(out.references).toBe('<r1@x.com>');
        expect(out.messageId).toBe('<draft-1@test.eigen.is>'); // preload sets domain test.eigen.is
    });
});
