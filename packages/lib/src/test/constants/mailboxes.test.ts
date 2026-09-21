import { describe, expect, test } from 'bun:test';
import {
    canonicalMailbox,
    isStandardMailbox,
    MAILBOX_ARCHIVE,
    MAILBOX_INBOX,
    MAILBOX_INBOX_KEY,
    MAILBOX_SENT,
    mailboxDisplayName,
    mailboxListFlags,
    mailboxRouteSegment,
} from '../../constants/mailboxes';

describe('canonicalMailbox', () => {
    test('a standard name in any case is that mailbox', () => {
        expect(canonicalMailbox('archive')).toBe(MAILBOX_ARCHIVE);
        expect(canonicalMailbox('SENT')).toBe(MAILBOX_SENT);
    });

    test('INBOX in any case is the inbox, which has no name at all', () => {
        expect(canonicalMailbox('INBOX')).toBe(MAILBOX_INBOX);
        expect(canonicalMailbox('inbox')).toBe(MAILBOX_INBOX);
        expect(canonicalMailbox(MAILBOX_INBOX)).toBe(MAILBOX_INBOX);
    });

    test('a folder outside the standard set keeps its own name', () => {
        expect(canonicalMailbox('Projects')).toBe('Projects');
        expect(canonicalMailbox('projects')).toBe('projects');
    });

    test('either delimiter names one folder, and the dotted form is the one that travels', () => {
        expect(canonicalMailbox('Clients/Acme')).toBe('Clients.Acme');
        expect(canonicalMailbox('Clients/Acme/2026')).toBe('Clients.Acme.2026');
        expect(canonicalMailbox('Clients.Acme')).toBe('Clients.Acme');
    });
});

describe('isStandardMailbox', () => {
    test('a folder whose name folds onto a standard one is not a folder of its own', () => {
        expect(isStandardMailbox('archive')).toBe(true);
        expect(isStandardMailbox('SENT')).toBe(true);
        expect(isStandardMailbox('INBOX')).toBe(true);
        expect(isStandardMailbox('inbox')).toBe(true);
    });

    test('a folder the user made is its own mailbox', () => {
        expect(isStandardMailbox('Projects')).toBe(false);
        expect(isStandardMailbox('Clients.Acme')).toBe(false);
    });
});

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

describe('mailboxDisplayName', () => {
    test('the Maildir++ delimiter reads as nesting', () => {
        expect(mailboxDisplayName('Clients.Acme')).toBe('Clients/Acme');
    });

    test('a name Dovecot spelled in modified UTF-7 reads as the letters it stands for', () => {
        expect(mailboxDisplayName('&AMQ-rger')).toBe('Ärger');
        expect(mailboxDisplayName('R&-D')).toBe('R&D');
        expect(mailboxDisplayName('&U,BTFw-')).toBe('台北');
        expect(mailboxDisplayName('Clients.&U,BTFw-')).toBe('Clients/台北');
    });

    test('a name that is not modified UTF-7 is shown as it stands', () => {
        expect(mailboxDisplayName('R&D')).toBe('R&D');
        expect(mailboxDisplayName('A&B-C')).toBe('A&B-C');
    });
});

describe('mailboxListFlags', () => {
    test('a custom folder carries no special-use flag', () => {
        expect(mailboxListFlags('Projects')).toEqual(['\\HasNoChildren']);
    });
});
