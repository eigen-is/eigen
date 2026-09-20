import { describe, expect, test } from 'bun:test';
import {
    MAILBOX_INBOX,
    MAILBOX_INBOX_KEY,
    MAILBOX_SENT,
    mailboxListFlags,
    mailboxRouteSegment,
} from '../../constants/mailboxes';

describe('mailboxRouteSegment', () => {
    test('the inbox travels as its key', () => {
        expect(mailboxRouteSegment(MAILBOX_INBOX)).toBe(MAILBOX_INBOX_KEY);
    });

    test('a standard mailbox lowercases, because the server case-folds it back', () => {
        expect(mailboxRouteSegment(MAILBOX_SENT)).toBe('sent');
    });

    test('a custom folder keeps its case, because the server takes its name literally', () => {
        expect(mailboxRouteSegment('Projects')).toBe('Projects');
        expect(mailboxRouteSegment('Clients.Acme')).toBe('Clients.Acme');
    });
});

describe('mailboxListFlags', () => {
    test('a custom folder carries no special-use flag', () => {
        expect(mailboxListFlags('Projects')).toEqual(['\\HasNoChildren']);
    });
});
