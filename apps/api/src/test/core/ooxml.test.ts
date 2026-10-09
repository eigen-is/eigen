import { describe, expect, test } from 'bun:test';
import { codeBlockLanguage, codeBlockStyle, headingLevel, headingStyleName, STYLE_NAMES } from '../../lib/core/ooxml';

describe('the heading style name', () => {
    test('reads back as its level, in any case', () => {
        expect(headingLevel(headingStyleName(3))).toBe(3);
        expect(headingLevel('Heading 9')).toBe(9);
    });

    test('any other name has no level', () => {
        expect(headingLevel('heading 10')).toBeUndefined();
        expect(headingLevel('heading 0')).toBeUndefined();
        expect(headingLevel('Heading1')).toBeUndefined();
        expect(headingLevel('TOC Heading')).toBeUndefined();
    });
});

describe('the code block language carrier', () => {
    test('a language is a style of its own, named after Code Block', () => {
        expect(codeBlockStyle('javascript')).toEqual({ id: 'CodeBlock-javascript', name: 'Code Block (javascript)' });
    });

    test('its name reads back as the language, in any case', () => {
        expect(codeBlockLanguage(codeBlockStyle('javascript').name)).toBe('javascript');
        expect(codeBlockLanguage('code block (plaintext)')).toBe('plaintext');
    });

    test('any other style carries no language', () => {
        expect(codeBlockLanguage(STYLE_NAMES.CodeBlock)).toBeUndefined();
        expect(codeBlockLanguage('Code Block ()')).toBeUndefined();
        expect(codeBlockLanguage('HTML Preformatted')).toBeUndefined();
    });
});
