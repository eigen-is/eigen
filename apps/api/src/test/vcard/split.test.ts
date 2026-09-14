// splitVCards is the only multi-card entry point in the codebase: parseVCardLines rejects multi-card
// payloads, so an import file is split here first and each card parsed on its own.
import { describe, expect, test } from 'bun:test';
import { splitVCards, VCardError } from '../../lib/vcard';

const card = (fn: string, eol = '\r\n') =>
    ['BEGIN:VCARD', 'VERSION:3.0', `FN:${fn}`, `N:;${fn};;;`, 'END:VCARD'].join(eol);

describe('splitVCards', () => {
    test('empty and whitespace-only input yields no cards', () => {
        expect(splitVCards('')).toEqual([]);
        expect(splitVCards('\r\n\r\n')).toEqual([]);
    });
    test('one CRLF card round-trips byte-identically', () => {
        const c = card('Ada');
        expect(splitVCards(`${c}\r\n`)).toEqual([`${c}\r\n`]);
    });
    test('three LF cards with blank lines and a BOM', () => {
        const text = `\uFEFF${[card('A', '\n'), '', card('B', '\n'), '', '', card('C', '\n')].join('\n')}\n`;
        expect(splitVCards(text).map((c) => c.split('\n')[2])).toEqual(['FN:A', 'FN:B', 'FN:C']);
    });
    test('a BOM between cards belongs to neither and is not content outside the envelope', () => {
        // `cat a.vcf b.vcf`: every exported file carries its own BOM, so one lands mid-file.
        const text = `\uFEFF${card('A')}\r\n\uFEFF${card('B')}\r\n`;
        expect(splitVCards(text)).toEqual([`${card('A')}\r\n`, `${card('B')}\r\n`]);
    });
    test('case-insensitive envelope markers', () => {
        expect(splitVCards('begin:vcard\r\nVERSION:3.0\r\nFN:x\r\nend:vcard\r\n')).toHaveLength(1);
    });
    test('an escaped BEGIN inside a NOTE value does not start a card', () => {
        const text = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nNOTE:see BEGIN:VCARD in docs\r\nEND:VCARD\r\n';
        expect(splitVCards(text)).toHaveLength(1);
    });
    test('unterminated envelope throws', () => {
        expect(() => splitVCards('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\n')).toThrow(VCardError);
    });
    test('non-blank content outside an envelope throws', () => {
        expect(() => splitVCards(`junk\r\n${card('A')}`)).toThrow(VCardError);
    });
    test('a folded continuation line is never an envelope marker', () => {
        const begin = 'BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:aaa\r\n BEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n';
        expect(splitVCards(begin)).toEqual([begin]);
        const tabbed = 'BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:aaa\r\n\tBEGIN:VCARD\r\nFN:x\r\nEND:VCARD\r\n';
        expect(splitVCards(tabbed)).toEqual([tabbed]);
        const end = 'BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:aaa\r\n END:VCARD\r\nFN:x\r\nEND:VCARD\r\n';
        expect(splitVCards(end)).toEqual([end]);
    });
    test('a card whose only END:VCARD is folded is unterminated', () => {
        expect(() => splitVCards('BEGIN:VCARD\r\nVERSION:3.0\r\nNOTE:aaa\r\n END:VCARD\r\n')).toThrow(
            'missing END:VCARD',
        );
    });
    test('a second BEGIN:VCARD inside an open card throws', () => {
        expect(() => splitVCards('BEGIN:VCARD\r\nVERSION:3.0\r\nBEGIN:VCARD\r\nEND:VCARD\r\n')).toThrow(
            'nested BEGIN:VCARD',
        );
    });
    test('a final card with no terminator comes back without one', () => {
        const c = card('Ada');
        expect(splitVCards(c)).toEqual([c]);
    });
    test('mixed line endings inside one card are preserved', () => {
        const mixed = 'BEGIN:VCARD\nVERSION:3.0\r\nFN:x\nEND:VCARD\r\n';
        expect(splitVCards(mixed)).toEqual([mixed]);
    });
    test('trailing spaces after END:VCARD still close the card', () => {
        expect(splitVCards('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:x\r\nEND:VCARD  \r\n')).toHaveLength(1);
    });
});
