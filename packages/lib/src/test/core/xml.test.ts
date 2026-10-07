import { describe, expect, test } from 'bun:test';
import { escapeXml, escapeXmlText } from '../../core/xml';

const chars = (...codes: number[]) => codes.map((code) => String.fromCharCode(code));

// Every character XML 1.0 § 2.2 can't hold, lone surrogates included: lows before highs, so joined they stay lone.
const INVALID = chars(
    ...Array.from({ length: 0x09 }, (_, i) => i),
    0x0b,
    0x0c,
    ...Array.from({ length: 0x20 - 0x0e }, (_, i) => 0x0e + i),
    0xfffe,
    0xffff,
    0xdc00,
    0xdfff,
    0xd800,
    0xdbff,
);

const attribute = (xml: string) => Bun.XML.parse(`<e a="${xml}"/>`, { compact: false }).attributes.a;

describe('escapeXml', () => {
    test('escapes the five predefined entities', () => {
        expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    });

    test('escapes tab, LF and CR as character references', () => {
        expect(escapeXml('a\tb\nc\rd')).toBe('a&#9;b&#10;c&#13;d');
    });

    test('tab, LF and CR in an attribute survive a parse', () => {
        const value = 'x\ty\nz\r\nw\r';
        expect(attribute(escapeXml(value))).toBe(value);
    });

    test.each(INVALID.map((ch) => [ch.charCodeAt(0).toString(16).padStart(4, '0'), ch]))('drops U+%s', (_, ch) => {
        const escaped = escapeXml(`a${ch}b`);
        expect(escaped).toBe('ab');
        expect(attribute(escaped)).toBe('ab');
    });

    test('keeps a valid surrogate pair and drops a reversed one', () => {
        const [high, low] = chars(0xd83d, 0xde00);
        expect(escapeXml(`a${high}${low}b`)).toBe(`a${high}${low}b`);
        expect(escapeXml(`a${low}${high}b`)).toBe('ab');
    });

    test('keeps the characters at the edges of the invalid ranges', () => {
        const valid = [
            ...chars(0x20, 0x7f, 0x85, 0xd7ff, 0xe000, 0xfffd),
            String.fromCodePoint(0x10000, 0x10ffff),
        ].join('');
        expect(escapeXml(valid)).toBe(valid);
        expect(attribute(escapeXml(valid))).toBe(valid);
    });
});

describe('escapeXmlText', () => {
    test('keeps CRLF and tab raw', () => {
        const vcard = 'BEGIN:VCARD\r\nNOTE:a\tb\r\nEND:VCARD\r\n';
        expect(escapeXmlText(vcard)).toBe(vcard);
    });

    test('escapes the five predefined entities and drops what XML cannot hold', () => {
        expect(escapeXmlText(`a&b<c>d"e'f${INVALID.join('')}`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    });
});
