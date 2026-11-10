import { describe, expect, test } from 'bun:test';
import ICAL from 'ical.js';
import { cpuClock } from '../cpu-time';

const contentLine = (line: string) =>
    ICAL.parse(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', line, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n'))[2][0][1][0];

describe('ical.js content line parameters', () => {
    test.each([
        ['a quoted value holding a colon and a semicolon', 'X-A;B="a:b;c";D=e:v', { b: 'a:b;c', d: 'e' }, 'v'],
        ['a quoted value last', 'X-A;B=c;D="a:b;c":v', { b: 'c', d: 'a:b;c' }, 'v'],
        ['two quoted values', 'X-A;B=";:";D=":;":v', { b: ';:', d: ':;' }, 'v'],
        ['a semicolon in the value after an unquoted parameter', 'X-A;B=1:v;C=2:w', { b: '1' }, 'v;C=2:w'],
        ['a semicolon in the value after a quoted parameter', 'X-A;B="1":v;C=2:w', { b: '1' }, 'v;C=2:w'],
        ['a colon in the value', 'X-A;B=1;C="x":http://a;b=c', { b: '1', c: 'x' }, 'http://a;b=c'],
        ['an equals sign in the value', 'X-A;B=1:c=d', { b: '1' }, 'c=d'],
        ['an empty parameter value', 'X-A;B=;C=2:v', { b: '', c: '2' }, 'v'],
        ['a text after the closing quote', 'X-A;B="1"x;C=2:v', { b: '1', c: '2' }, 'v'],
    ])('%s', (_name, line, params, value) => {
        const [, parsedParams, , parsedValue] = contentLine(line);
        expect(parsedParams).toEqual(params);
        expect(parsedValue).toBe(value);
    });

    test('a multi-valued parameter holding colons stays one parameter', () => {
        const [name, params, , value] = contentLine(
            'ATTENDEE;MEMBER="mailto:a@b","mailto:c@d";CN="x;y:z";ROLE=CHAIR:mailto:e@f',
        );
        expect(name).toBe('attendee');
        expect(params).toEqual({ member: ['mailto:a@b', 'mailto:c@d'], cn: 'x;y:z', role: 'CHAIR' });
        expect(value).toBe('mailto:e@f');
    });

    test('a line whose parameters never reach a colon is refused', () => {
        expect(() => contentLine('X-A;B=1;C=2')).toThrow(ICAL.parse.ParserError);
        expect(() => contentLine('X-A;B="1";C="2"')).toThrow(ICAL.parse.ParserError);
    });

    test.each([
        ['unquoted', ';A=1'],
        ['quoted', ';A="1"'],
    ])(
        'a line of a million bytes of %s parameters parses in time linear in its length',
        (_name, parameter) => {
            const line = `X-A${parameter.repeat(Math.floor(1_048_576 / parameter.length))}:v`;
            const cpuMs = cpuClock();
            const [, params, , value] = contentLine(line);
            expect(cpuMs()).toBeLessThan(700);
            expect(params).toEqual({ a: '1' });
            expect(value).toBe('v');
        },
        120_000,
    );
});
