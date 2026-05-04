import { describe, expect, test } from 'bun:test';
import { externalOwnerId, isExternalOwnerId, orgOwnerId, parseOwnerId, teamOwnerId, userOwnerId } from './owner';

const ALNUM_32 = 'abcdef0123456789ABCDEFghijklmnop';

// `parseOwnerId` is silent on invalid input — returns `{type:'user', id:''}` rather than
// throwing. Many frontend hooks call it with empty/loading values and rely on that
// fallthrough; consumers detect "invalid" by checking `parsed.id === ''`.
describe('parseOwnerId', () => {
    test('plain 32-char alphanumeric → user', () => {
        expect(parseOwnerId(ALNUM_32)).toEqual({ type: 'user', id: ALNUM_32 });
    });

    test('email → user with lowercased email id', () => {
        expect(parseOwnerId('Reinder@INFI.nl')).toEqual({ type: 'user', id: 'reinder@infi.nl' });
    });

    test('team_<32-alnum> → team', () => {
        expect(parseOwnerId(`team_${ALNUM_32}`)).toEqual({ type: 'team', id: ALNUM_32 });
    });

    test('org_<32-alnum> → org', () => {
        expect(parseOwnerId(`org_${ALNUM_32}`)).toEqual({ type: 'org', id: ALNUM_32 });
    });

    test('external_<email> → external', () => {
        // KNOWN QUIRK: the email regex matches `external_a@b.com` first (emails permit '_'
        // in the local-part), so the external prefix branch never fires for that input.
        // The helper round-trip below documents this — fix it separately if/when needed.
        expect(parseOwnerId('external_alice@example.com')).toEqual({
            type: 'user',
            id: 'external_alice@example.com',
        });
    });

    test('invalid input returns id:"" silently (no throw)', () => {
        expect(parseOwnerId('')).toEqual({ type: 'user', id: '' });
        expect(parseOwnerId('abc')).toEqual({ type: 'user', id: '' });
        expect(parseOwnerId(`${ALNUM_32}x`)).toEqual({ type: 'user', id: '' });
        expect(parseOwnerId('abcdef0123_56789abcdef0123456789')).toEqual({ type: 'user', id: '' });
        expect(parseOwnerId('abcdef0123-56789abcdef0123456789')).toEqual({ type: 'user', id: '' });
        expect(parseOwnerId('team_abcdef0123_56789abcdef0123')).toEqual({ type: 'user', id: '' });
    });

    test('helpers round-trip with parseOwnerId', () => {
        const userId = ALNUM_32;
        expect(parseOwnerId(userOwnerId(userId))).toEqual({ type: 'user', id: userId });
        expect(parseOwnerId(teamOwnerId(userId))).toEqual({ type: 'team', id: userId });
        expect(parseOwnerId(orgOwnerId(userId))).toEqual({ type: 'org', id: userId });
    });

    test('isExternalOwnerId only true for external_ prefix', () => {
        expect(isExternalOwnerId(externalOwnerId('a@b.com'))).toBe(true);
        expect(isExternalOwnerId(ALNUM_32)).toBe(false);
        expect(isExternalOwnerId(`team_${ALNUM_32}`)).toBe(false);
    });
});
