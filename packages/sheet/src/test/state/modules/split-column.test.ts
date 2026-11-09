import { describe, expect, test } from 'bun:test';
import { getRegStr } from '../../../state/modules/split-column';

const splits = (selected: string[], other: string, text: string) =>
    text.split(new RegExp(getRegStr(new Set(selected), other), 'g'));

describe('getRegStr', () => {
    test('an Other separator is the literal text typed, so a regex character neither throws nor means anything', () => {
        expect(splits(['other'], '(', 'a(b')).toEqual(['a', 'b']);
        expect(splits(['other'], '.', 'a.b')).toEqual(['a', 'b']);
        expect(splits(['other', 'comma'], '+', 'a+b,c')).toEqual(['a', 'b', 'c']);
    });

    test('treating consecutive separators as one splits on the chosen separators only', () => {
        expect(splits(['comma', 'semicolon', 'splitsimple'], '', 'a,;b|c')).toEqual(['a', 'b|c']);
    });

    test('a separator word as Other stays whole when consecutive ones count as one', () => {
        expect(splits(['other', 'splitsimple'], 'ab', 'xababy b')).toEqual(['x', 'y b']);
    });

    test('nothing chosen splits nothing', () => {
        expect(getRegStr(new Set(['splitsimple']), '')).toBe('');
    });
});
