import { describe, expect, test } from 'bun:test';
import { parseQuery } from '../../../core/command-palette/parse-query';

describe('parseQuery', () => {
    test('empty input returns an empty q', () => {
        expect(parseQuery('')).toEqual({ q: '' });
        expect(parseQuery('   ')).toEqual({ q: '' });
    });

    test('plain text becomes q untouched', () => {
        expect(parseQuery('q3 budget')).toEqual({ q: 'q3 budget' });
    });

    test('mail: prefix sets scope and strips the prefix', () => {
        expect(parseQuery('mail: q3 budget')).toEqual({ scope: 'mail', q: 'q3 budget' });
        expect(parseQuery('mail:q3')).toEqual({ scope: 'mail', q: 'q3' });
    });

    test('doc: prefix sets the doc scope and strips the prefix', () => {
        expect(parseQuery('doc: q3 budget')).toEqual({ scope: 'doc', q: 'q3 budget' });
        expect(parseQuery('doc:q3')).toEqual({ scope: 'doc', q: 'q3' });
    });

    test('> prefix sets the actions scope', () => {
        expect(parseQuery('> new doc')).toEqual({ scope: 'actions', q: 'new doc' });
        expect(parseQuery('>new doc')).toEqual({ scope: 'actions', q: 'new doc' });
    });

    test('@ prefix sets the contacts scope', () => {
        expect(parseQuery('@ alice')).toEqual({ scope: 'contacts', q: 'alice' });
        expect(parseQuery('@alice')).toEqual({ scope: 'contacts', q: 'alice' });
    });

    test('? prefix sets the help scope', () => {
        expect(parseQuery('? share a file')).toEqual({ scope: 'help', q: 'share a file' });
        expect(parseQuery('?share a file')).toEqual({ scope: 'help', q: 'share a file' });
    });

    test('from: operator extracts the sender filter', () => {
        expect(parseQuery('from:alice@example.com q3')).toEqual({
            from: 'alice@example.com',
            q: 'q3',
        });
    });

    test('to: operator extracts the recipient filter', () => {
        expect(parseQuery('to:bob@example.com q3')).toEqual({
            to: 'bob@example.com',
            q: 'q3',
        });
    });

    test('combines scope + from + to + text', () => {
        expect(parseQuery('mail: from:alice@x.com to:bob q3')).toEqual({
            scope: 'mail',
            from: 'alice@x.com',
            to: 'bob',
            q: 'q3',
        });
    });

    test('operator with no value falls through as plain text', () => {
        expect(parseQuery('from: q3')).toEqual({ q: 'from: q3' });
        expect(parseQuery('from:')).toEqual({ q: 'from:' });
    });

    test('the scope prefix must be at the very start to count', () => {
        expect(parseQuery('subject mail: q3')).toEqual({ q: 'subject mail: q3' });
    });
});
