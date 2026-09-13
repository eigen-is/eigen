// splitVCards is the only multi-card entry point in the codebase: parseVCardLines rejects multi-card
// payloads, so an import file is split here first and each card parsed on its own.
import { describe, expect, test } from 'bun:test';
import { splitVCards, VCardError } from '@workspace/lib/vcard';

const card = (fn: string, eol = '\r\n') =>
    ['BEGIN:VCARD', 'VERSION:3.0', `FN:${fn}`, 'N:;' + fn + ';;;', 'END:VCARD'].join(eol);

describe('splitVCards', () => {
    test('empty and whitespace-only input yields no cards', () => {
        expect(splitVCards('')).toEqual([]);
        expect(splitVCards('\r\n\r\n')).toEqual([]);
    });
    test('one CRLF card round-trips byte-identically', () => {
        const c = card('Ada');
        expect(splitVCards(c + '\r\n')).toEqual([c + '\r\n']);
    });
    test('three LF cards with blank lines and a BOM', () => {
        const text = '﻿' + [card('A', '\n'), '', card('B', '\n'), '', '', card('C', '\n')].join('\n') + '\n';
        expect(splitVCards(text).map((c) => c.split('\n')[2])).toEqual(['FN:A', 'FN:B', 'FN:C']);
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
        expect(() => splitVCards('junk\r\n' + card('A'))).toThrow(VCardError);
    });
});
