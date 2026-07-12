import { describe, expect, test } from 'bun:test';
import { type PeerPresence, presencesFromPeers } from '../presence';

describe('state/presence/presencesFromPeers', () => {
    const alice: PeerPresence = {
        user: { name: 'Alice', color: '#ff0000', userId: 'alice' },
        selection: { sheetId: 's1', r: 3, c: 4 },
    };

    test('projects a peer to a Presence row', () => {
        expect(presencesFromPeers([alice], 'me')).toEqual([
            { sheetId: 's1', username: 'Alice', userId: 'alice', color: '#ff0000', selection: { r: 3, c: 4 } },
        ]);
    });

    test('skips the local user (own id) so no self-cursor across tabs', () => {
        expect(presencesFromPeers([alice], 'alice')).toEqual([]);
    });

    test('skips peers that published identity but no cursor yet', () => {
        const noSelection: PeerPresence = { user: { name: 'Bob', color: '#00ff00', userId: 'bob' } };
        expect(presencesFromPeers([noSelection], 'me')).toEqual([]);
    });

    test('skips peers that published a cursor but no identity', () => {
        const noUser: PeerPresence = { selection: { sheetId: 's1', r: 0, c: 0 } };
        expect(presencesFromPeers([noUser], 'me')).toEqual([]);
    });

    test('keeps a peer without a userId (identity present, id unknown)', () => {
        const anon: PeerPresence = {
            user: { name: 'Guest', color: '#0000ff' },
            selection: { sheetId: 's1', r: 1, c: 1 },
        };
        expect(presencesFromPeers([anon], 'me')).toEqual([
            { sheetId: 's1', username: 'Guest', userId: undefined, color: '#0000ff', selection: { r: 1, c: 1 } },
        ]);
    });
});
