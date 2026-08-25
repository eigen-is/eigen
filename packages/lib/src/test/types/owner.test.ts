import { describe, expect, test } from 'bun:test';
import {
    externalOwnerId,
    isExternalOwnerId,
    orgOwnerId,
    parseOwnerId,
    teamOwnerId,
    userOwnerId,
} from '../../types/owner';

const ALNUM_32 = 'abcdef0123456789ABCDEFghijklmnop';

// `parseOwnerId` is silent on invalid input — returns `{type:'invalid', id:''}` rather than
// throwing. Many frontend hooks call it with empty/loading values and rely on that
// fallthrough; consumers detect "invalid" via the `type: 'invalid'` discriminant or the
// preserved `parsed.id === ''` sentinel.
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

    test('external_<email> → external (prefix wins over email regex)', () => {
        expect(parseOwnerId('external_alice@example.com')).toEqual({
            type: 'external',
            id: 'alice@example.com',
        });
    });

    test('invalid input returns type:"invalid", id:"" silently (no throw)', () => {
        expect(parseOwnerId('')).toEqual({ type: 'invalid', id: '' });
        expect(parseOwnerId('abc')).toEqual({ type: 'invalid', id: '' });
        expect(parseOwnerId(`${ALNUM_32}x`)).toEqual({ type: 'invalid', id: '' });
        expect(parseOwnerId('abcdef0123_56789abcdef0123456789')).toEqual({ type: 'invalid', id: '' });
        expect(parseOwnerId('abcdef0123-56789abcdef0123456789')).toEqual({ type: 'invalid', id: '' });
        expect(parseOwnerId('team_abcdef0123_56789abcdef0123')).toEqual({ type: 'invalid', id: '' });
    });

    test('helpers round-trip with parseOwnerId', () => {
        const userId = ALNUM_32;
        expect(parseOwnerId(userOwnerId(userId))).toEqual({ type: 'user', id: userId });
        expect(parseOwnerId(teamOwnerId(userId))).toEqual({ type: 'team', id: userId });
        expect(parseOwnerId(orgOwnerId(userId))).toEqual({ type: 'org', id: userId });
        expect(parseOwnerId(externalOwnerId('a@b.com'))).toEqual({ type: 'external', id: 'a@b.com' });
    });

    test('isExternalOwnerId only true for external_ prefix', () => {
        expect(isExternalOwnerId(externalOwnerId('a@b.com'))).toBe(true);
        expect(isExternalOwnerId(ALNUM_32)).toBe(false);
        expect(isExternalOwnerId(`team_${ALNUM_32}`)).toBe(false);
    });
});
