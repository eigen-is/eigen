import { describe, expect, test } from 'bun:test';
import { formatSyncToken, invalidSyncToken, parseSyncToken } from '../../lib/dav/sync-token';

// The emit and parse halves of one grammar: drift between them sends every client into a permanent
// full-resync loop, so they are pinned against each other here rather than in a protocol suite.

describe('sync token grammar', () => {
    test('a formatted token parses back to the generation and ctag it carries', () => {
        expect(formatSyncToken({ syncGen: 7, ctag: 42 })).toBe('urn:eigen:sync:7-42');
        expect(parseSyncToken(formatSyncToken({ syncGen: 7, ctag: 42 }))).toEqual({ gen: 7, since: 42 });
    });

    test('a token from another generation parses, so the caller can refuse it', () => {
        expect(parseSyncToken('urn:eigen:sync:6-42')).toEqual({ gen: 6, since: 42 });
    });

    test('a token in any other shape is null', () => {
        for (const token of ['urn:eigen:sync:42', 'urn:eigen:sync/7-42', 'urn:eigen:sync:a-42', '', 'nonsense']) {
            expect(parseSyncToken(token)).toBeNull();
        }
    });
});

describe('invalidSyncToken', () => {
    test('answers 403 valid-sync-token, the status clients key their full resync on', async () => {
        const res = invalidSyncToken();

        expect(res.status).toBe(403);
        expect(await res.text()).toContain('<D:valid-sync-token/>');
    });
});
