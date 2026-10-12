import { afterAll, describe, expect, test } from 'bun:test';
import type { Email } from '@workspace/lib/types/mail';
import { Window } from 'happy-dom';
import { formatEmailQuote } from '../../../../components/mail/hooks/use-mail-actions';

// The strip parses with DOMParser.
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const previousDomParser = g.DOMParser;
g.DOMParser = new Window().DOMParser;
afterAll(() => {
    g.DOMParser = previousDomParser;
});

const HOST = 'tracker.example';

function received(html: string): Email {
    return {
        id: 'msg-1',
        filename: 'msg-1.eml',
        subject: 'Newsletter',
        from: { value: [{ name: 'Sender', address: 'sender@example.com' }], text: '' },
        fromShort: 'Sender',
        fromAddress: 'sender@example.com',
        toShort: 'Alice',
        toAddress: 'alice@test.eigen.is',
        recipientsAll: 'alice@test.eigen.is',
        textShort: 'hello',
        date: new Date('2026-10-12T10:00:00Z'),
        isRead: true,
        isFlagged: false,
        isDraft: false,
        isReplied: false,
        hasAttachments: false,
        mailbox: 'INBOX',
        size: 100,
        attachments: [],
        html,
        text: 'hello',
    };
}

// Reply and Forward quote the body as the reader shows it, so the composer loads what the reader held back
// only once Load images was clicked for that message.
describe('formatEmailQuote', () => {
    const email = received(
        `<p>hello</p><img src="https://${HOST}/pixel.gif"><div style="background:url(https://${HOST}/bg.png)">x</div>`,
    );

    test('quotes no remote reference before Load images', () => {
        const quote = formatEmailQuote(email, false);
        expect(quote).not.toContain(HOST);
        expect(quote).toContain('<p>hello</p>');
    });

    test('quotes the message as it came once its images were loaded', () => {
        expect(formatEmailQuote(email, true)).toContain(`src="https://${HOST}/pixel.gif"`);
    });
});
