// A peer's awareness state as the cursor the grid draws for it, one per window it has open.

import { describe, expect, test } from 'bun:test';
import type { PeerPresence } from '../../state/presence';
import { presencesFromPeers } from '../../state/presence';

describe('state/presence/presencesFromPeers', () => {
    const alice: PeerPresence = {
        user: { name: 'Alice', color: '#ff0000', userId: 'alice' },
        selection: { sheetId: 's1', r: 3, c: 4 },
    };

    test('projects a peer to a Presence row', () => {
        expect(presencesFromPeers(new Map([[7, alice]]))).toEqual([
            {
                clientId: 7,
                sheetId: 's1',
                username: 'Alice',
                userId: 'alice',
                color: '#ff0000',
                selection: { r: 3, c: 4 },
            },
        ]);
    });

    // The local client is omitted upstream (useAwarenessPeers), so an entry sharing the local userId is the user's
    // other window and renders like any peer, as in the other apps.
    test('keeps each window of one user as its own row, told apart by its client', () => {
        const other = { ...alice, selection: { sheetId: 's1', r: 5, c: 0 } };
        const rows = presencesFromPeers(
            new Map([
                [7, alice],
                [8, other],
            ]),
        );
        expect(rows.map((row) => [row.userId, row.clientId])).toEqual([
            ['alice', 7],
            ['alice', 8],
        ]);
    });

    test('skips peers that published identity but no cursor yet', () => {
        const noSelection: PeerPresence = { user: { name: 'Bob', color: '#00ff00', userId: 'bob' } };
        expect(presencesFromPeers(new Map([[1, noSelection]]))).toEqual([]);
    });

    test('skips peers that published a cursor but no identity', () => {
        const noUser: PeerPresence = { selection: { sheetId: 's1', r: 0, c: 0 } };
        expect(presencesFromPeers(new Map([[1, noUser]]))).toEqual([]);
    });

    test('keeps a peer without a userId (identity present, id unknown)', () => {
        const anon: PeerPresence = {
            user: { name: 'Guest', color: '#0000ff' },
            selection: { sheetId: 's1', r: 1, c: 1 },
        };
        expect(presencesFromPeers(new Map([[1, anon]]))).toEqual([
            {
                clientId: 1,
                sheetId: 's1',
                username: 'Guest',
                userId: undefined,
                color: '#0000ff',
                selection: { r: 1, c: 1 },
            },
        ]);
    });
});
