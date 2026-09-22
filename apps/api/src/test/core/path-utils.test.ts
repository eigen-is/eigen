import { describe, expect, test } from 'bun:test';
import { isSafePathSegment } from '../../lib/core/path-utils';

describe('isSafePathSegment', () => {
    test('accepts the ids clients send back: a uuid, a Maildir id, a resource name', () => {
        expect(isSafePathSegment('7f3b1c2e-9a4d-4f10-8f2b-0c1d2e3f4a5b')).toBe(true);
        expect(isSafePathSegment('1758300000.M123000P4242Q0.mail.example.com')).toBe(true);
        expect(isSafePathSegment('ABC-123.vcf')).toBe(true);
        expect(isSafePathSegment('a.b@c')).toBe(true);
        expect(isSafePathSegment('a')).toBe(true);
    });

    test('rejects separators and traversal', () => {
        expect(isSafePathSegment('..')).toBe(false);
        expect(isSafePathSegment('../x')).toBe(false);
        expect(isSafePathSegment('../../.Sent/cur/pwn')).toBe(false);
        expect(isSafePathSegment('a/b')).toBe(false);
        expect(isSafePathSegment('a\\b')).toBe(false);
    });

    test('rejects a leading dot, dash, space and control characters', () => {
        expect(isSafePathSegment('.hidden')).toBe(false);
        expect(isSafePathSegment('-lead')).toBe(false);
        expect(isSafePathSegment(' lead')).toBe(false);
        expect(isSafePathSegment('a b')).toBe(false);
        expect(isSafePathSegment('a\nb')).toBe(false);
        expect(isSafePathSegment('a\x00b')).toBe(false);
    });

    test('rejects an empty name and caps the length at 200 bytes', () => {
        expect(isSafePathSegment('')).toBe(false);
        expect(isSafePathSegment('a'.repeat(200))).toBe(true);
        expect(isSafePathSegment('a'.repeat(201))).toBe(false);
        // An accented character costs two bytes, and NAME_MAX is a byte budget.
        expect(isSafePathSegment('é'.repeat(100))).toBe(true);
        expect(isSafePathSegment('é'.repeat(101))).toBe(false);
    });

    test('accepts accented and non-Latin names, composed or decomposed', () => {
        expect(isSafePathSegment('café')).toBe(true);
        expect(isSafePathSegment('café'.normalize('NFD'))).toBe(true);
        expect(isSafePathSegment('Zoë-Ångström.vcf')).toBe(true);
        expect(isSafePathSegment('会議')).toBe(true);
    });

    test('still rejects a leading combining mark and anything outside letters, marks and digits', () => {
        expect(isSafePathSegment('́abc')).toBe(false);
        expect(isSafePathSegment('café!')).toBe(false);
        expect(isSafePathSegment('🎉')).toBe(false);
    });
});
