import { describe, expect, test } from 'bun:test';
import { Token, tokens } from '../../text';

const NAMES = new Map<number, string>(Object.entries(Token).map(([name, kind]) => [kind, name]));

const cut = (text: string) =>
    tokens(text).map(({ kind, start, end }) => `${NAMES.get(kind)}:${text.slice(start, end)}`);

describe('tokens', () => {
    test('spans cover the text with no gap', () => {
        const text = '=IF( $A1>=10, SUM(Sheet2!A:A), "a ""(" )&\'My Sheet\'!B2:C3%';
        let at = 0;
        for (const token of tokens(text)) {
            expect(token.start).toBe(at);
            expect(token.end).toBeGreaterThan(token.start);
            at = token.end;
        }
        expect(at).toBe(text.length);
    });

    test('every kind a formula can hold', () => {
        expect(cut('=IF( $A1>=10, SUM(Sheet2!A:A), "a ""(" )&\'My Sheet\'!B2:C3%')).toEqual([
            'Equal:=',
            'Function:IF',
            'Open:(',
            'Space: ',
            'Reference:$A1',
            'GreaterEqual:>=',
            'Number:10',
            'Comma:,',
            'Space: ',
            'Function:SUM',
            'Open:(',
            'Reference:Sheet2!A:A',
            'Close:)',
            'Comma:,',
            'Space: ',
            'String:"a ""("',
            'Space: ',
            'Close:)',
            'Concat:&',
            "Reference:'My Sheet'!B2:C3",
            'Percent:%',
        ]);
    });

    test('a reference is one token: its sheet and both corners', () => {
        expect(cut('=A1:B2+$C$3+1:2+$A:B+[1]Book!A1')).toEqual([
            'Equal:=',
            'Reference:A1:B2',
            'Plus:+',
            'Reference:$C$3',
            'Plus:+',
            'Reference:1:2',
            'Plus:+',
            'Reference:$A:B',
            'Plus:+',
            'Reference:[1]Book!A1',
        ]);
    });

    test('a word is a function before (, else a reference, a boolean or a name', () => {
        expect(cut('=LOG10(LOG10)+true+Rate+XFE1+A')).toEqual([
            'Equal:=',
            'Function:LOG10',
            'Open:(',
            'Reference:LOG10',
            'Close:)',
            'Plus:+',
            'Boolean:true',
            'Plus:+',
            'Name:Rate',
            'Plus:+',
            'Name:XFE1',
            'Plus:+',
            'Name:A',
        ]);
    });

    test('the other tokens', () => {
        expect(cut('={1,-2;#N/A,"x"}<>A1#^.5*@B2/3<4<=5>6')).toEqual([
            'Equal:=',
            'BraceOpen:{',
            'Number:1',
            'Comma:,',
            'Minus:-',
            'Number:2',
            'Semicolon:;',
            'Error:#N/A',
            'Comma:,',
            'String:"x"',
            'BraceClose:}',
            'NotEqual:<>',
            'Reference:A1',
            'Hash:#',
            'Power:^',
            'Number:.5',
            'Multiply:*',
            'At:@',
            'Reference:B2',
            'Divide:/',
            'Number:3',
            'Less:<',
            'Number:4',
            'LessEqual:<=',
            'Number:5',
            'Greater:>',
            'Number:6',
        ]);
    });

    test('text that does not parse still has tokens, as while typing', () => {
        expect(cut('=SUM(A1,')).toEqual(['Equal:=', 'Function:SUM', 'Open:(', 'Reference:A1', 'Comma:,']);
        expect(cut('="open (')).toEqual(['Equal:=', 'Bad:"open (']);
        expect(cut("='My Sh")).toEqual(['Equal:=', "Bad:'My Sh"]);
        expect(cut('=Sheet2!')).toEqual(['Equal:=', 'Name:Sheet2', 'Bang:!']);
        expect(cut('=A1 ')).toEqual(['Equal:=', 'Reference:A1', 'Bad: ']);
        expect(cut('')).toEqual([]);
    });

    test('brackets inside a string or a quoted sheet name are not brackets', () => {
        const opens = (text: string) => tokens(text).filter((token) => token.kind === Token.Open).length;
        expect(opens('=SUM("(",\'a(b\'!A1,(1))')).toBe(2);
    });

    test('numbers, with and without an exponent', () => {
        expect(cut('=1E3+1.5e-3+5.+1E+')).toEqual([
            'Equal:=',
            'Number:1E3',
            'Plus:+',
            'Number:1.5e-3',
            'Plus:+',
            'Number:5.',
            'Plus:+',
            'Number:1',
            'Name:E',
            'Plus:+',
        ]);
    });

    test('a word before whitespace and ( is a function, unless it is a reference', () => {
        expect(cut('=SUM (1)+TRUE ()+A1 (B1)+RC (1)')).toEqual([
            'Equal:=',
            'Function:SUM',
            'Space: ',
            'Open:(',
            'Number:1',
            'Close:)',
            'Plus:+',
            'Function:TRUE',
            'Space: ',
            'Open:(',
            'Close:)',
            'Plus:+',
            'Reference:A1',
            'Space: ',
            'Open:(',
            'Reference:B1',
            'Close:)',
            'Plus:+',
            'Name:RC',
            'Space: ',
            'Open:(',
            'Number:1',
            'Close:)',
        ]);
    });

    test('a character no formula holds is one bad token, both halves of it', () => {
        expect(cut('=A1\u3000+\ud83d\ude00\u0394x')).toEqual([
            'Equal:=',
            'Reference:A1',
            'Bad:\u3000',
            'Plus:+',
            'Bad:\ud83d\ude00',
            'Name:\u0394x',
        ]);
    });
});
