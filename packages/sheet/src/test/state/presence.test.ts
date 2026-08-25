import { describe, expect, test } from 'bun:test';
import { type PeerPresence, presencesFromPeers } from '../../state/presence';

describe('state/presence/presencesFromPeers', () => {
    const alice: PeerPresence = {
        user: { name: 'Alice', color: '#ff0000', userId: 'alice' },
        selection: { sheetId: 's1', r: 3, c: 4 },
    };

    test('projects a peer to a Presence row', () => {
        expect(presencesFromPeers([alice])).toEqual([
            { sheetId: 's1', username: 'Alice', userId: 'alice', color: '#ff0000', selection: { r: 3, c: 4 } },
        ]);
    });

    test('keeps a same-user peer — the local tab is already absent, another window shows', () => {
        // The local client is omitted upstream (useAwarenessPeers), so an entry sharing the local
        // userId is the user's other window and must render like any peer (cross-app ruling).
        expect(presencesFromPeers([alice]).map((p) => p.userId)).toEqual(['alice']);
    });

    test('skips peers that published identity but no cursor yet', () => {
        const noSelection: PeerPresence = { user: { name: 'Bob', color: '#00ff00', userId: 'bob' } };
        expect(presencesFromPeers([noSelection])).toEqual([]);
    });

    test('skips peers that published a cursor but no identity', () => {
        const noUser: PeerPresence = { selection: { sheetId: 's1', r: 0, c: 0 } };
        expect(presencesFromPeers([noUser])).toEqual([]);
    });

    test('keeps a peer without a userId (identity present, id unknown)', () => {
        const anon: PeerPresence = {
            user: { name: 'Guest', color: '#0000ff' },
            selection: { sheetId: 's1', r: 1, c: 1 },
        };
        expect(presencesFromPeers([anon])).toEqual([
            { sheetId: 's1', username: 'Guest', userId: undefined, color: '#0000ff', selection: { r: 1, c: 1 } },
        ]);
    });
});
