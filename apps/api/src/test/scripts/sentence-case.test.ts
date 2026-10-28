// Tests the sentence-case check of scripts/check-standards.ts: a capital after the first word fails unless it is a proper noun.

import { describe, expect, test } from 'bun:test';
import { sentenceCaseHits } from '../../../../../scripts/sentence-case';

const hits = (source: string) => sentenceCaseHits('apps/x/src/a.tsx', source);

describe('sentenceCaseHits', () => {
    test('flags a title-case string in a label prop', () => {
        expect(hits('<Button label="Keep Aspect Ratio" />')).toEqual(['"Keep Aspect Ratio" (Aspect, Ratio)']);
        expect(hits("const x = { title: 'Page Setup' };")).toEqual(['"Page Setup" (Setup)']);
    });

    test('flags the text of a label element', () => {
        expect(hits('<DialogTitle>Delete Event</DialogTitle>')).toEqual(['"Delete Event" (Event)']);
        expect(hits('<FieldLabel htmlFor="a">Display Name</FieldLabel>')).toEqual(['"Display Name" (Name)']);
    });

    test('allows sentence case, proper nouns and acronyms', () => {
        expect(hits('<Button label="Keep aspect ratio" />')).toEqual([]);
        expect(hits('<Label>Import from Google Docs</Label>')).toEqual([]);
        expect(hits('<Button tooltipText="Open in Word as PDF" />')).toEqual([]);
    });

    test('ignores comments, dynamic text, other props and variables', () => {
        expect(hits('// label="Keep Aspect Ratio"\nconst a = 1;')).toEqual([]);
        expect(hits('<Label>Name {value} Here</Label>')).toEqual([]);
        expect(hits('<Button name="Keep Aspect Ratio" />')).toEqual([]);
        expect(hits("const title = 'Pivot Table';")).toEqual([]);
    });
});
