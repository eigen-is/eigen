import { describe, expect, test } from 'bun:test';
import { parseSmartInput } from '../../../core/command-palette/parse-smart-input';

describe('parseSmartInput', () => {
    test('a plain email returns an email parse', () => {
        expect(parseSmartInput('alice@example.com')).toEqual({ kind: 'email', value: 'alice@example.com' });
    });

    test('email with + tag and dots is recognised', () => {
        expect(parseSmartInput('alice+tag@example.co.uk')).toEqual({
            kind: 'email',
            value: 'alice+tag@example.co.uk',
        });
    });

    test('email inside other text returns null (whole-input only)', () => {
        expect(parseSmartInput('mail alice@example.com')).toBeNull();
    });

    test('https URL returns a url parse', () => {
        expect(parseSmartInput('https://example.com')).toEqual({
            kind: 'url',
            value: 'https://example.com',
        });
    });

    test('http URL is also accepted', () => {
        expect(parseSmartInput('http://localhost:8000')).toEqual({
            kind: 'url',
            value: 'http://localhost:8000',
        });
    });

    test('javascript: protocol is rejected (XSS guard)', () => {
        expect(parseSmartInput('javascript:alert(1)')).toBeNull();
    });

    test('file:, data:, mailto: protocols are rejected', () => {
        expect(parseSmartInput('file:///etc/passwd')).toBeNull();
        expect(parseSmartInput('data:text/html,<script>alert(1)</script>')).toBeNull();
        expect(parseSmartInput('mailto:alice@example.com')).toBeNull();
    });

    test('domain without protocol returns null (ambiguous)', () => {
        expect(parseSmartInput('example.com')).toBeNull();
    });

    test('whitespace is trimmed before matching', () => {
        expect(parseSmartInput('   alice@example.com   ')).toEqual({
            kind: 'email',
            value: 'alice@example.com',
        });
    });

    test('plain text returns null', () => {
        expect(parseSmartInput('not a parse')).toBeNull();
    });
});
