import { describe, expect, test } from 'bun:test';
import { externalOwnerId, isExternalOwnerId, orgOwnerId, parseOwnerId, teamOwnerId, userOwnerId } from './owner';

const ALNUM_32 = 'abcdef0123456789ABCDEFghijklmnop';

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
        expect(parseOwnerId('external_alice@example.com')).toEqual({ type: 'external', id: 'alice@example.com' });
    });

    test('rejects 32-char id containing _', () => {
        expect(() => parseOwnerId('abcdef0123_56789abcdef0123456789')).toThrow();
    });

    test('rejects 32-char id containing -', () => {
        expect(() => parseOwnerId('abcdef0123-56789abcdef0123456789')).toThrow();
    });

    test('rejects empty string', () => {
        expect(() => parseOwnerId('')).toThrow();
    });

    test('rejects too short', () => {
        expect(() => parseOwnerId('abc')).toThrow();
    });

    test('rejects too long (33-alnum)', () => {
        expect(() => parseOwnerId(`${ALNUM_32}x`)).toThrow();
    });

    test('rejects team_ prefix with non-alnum body', () => {
        expect(() => parseOwnerId('team_abcdef0123_56789abcdef0123')).toThrow();
    });

    test('helpers round-trip with parseOwnerId', () => {
        const userId = ALNUM_32;
        expect(parseOwnerId(userOwnerId(userId))).toEqual({ type: 'user', id: userId });
        expect(parseOwnerId(teamOwnerId(userId))).toEqual({ type: 'team', id: userId });
        expect(parseOwnerId(orgOwnerId(userId))).toEqual({ type: 'org', id: userId });
        expect(parseOwnerId(externalOwnerId('a@b.com'))).toEqual({ type: 'external', id: 'a@b.com' });
    });

    test('isExternalOwnerId only true for external_ prefix', () => {
        expect(isExternalOwnerId('external_a@b.com')).toBe(true);
        expect(isExternalOwnerId(ALNUM_32)).toBe(false);
        expect(isExternalOwnerId(`team_${ALNUM_32}`)).toBe(false);
    });
});
