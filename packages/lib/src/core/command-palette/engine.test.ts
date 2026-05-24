import { describe, expect, test } from 'bun:test';
import type { PaletteResult } from '@workspace/lib/types/command-palette';
import type { EmailSummary } from '@workspace/lib/types/mail';
import { Mail, Search } from 'lucide-react';
import { buildSections } from './engine';

function action(id: string, title: string, rank: number): PaletteResult {
    return {
        kind: 'action',
        id,
        title,
        icon: Search,
        group: 'actions',
        rank,
        run: () => {},
    };
}

function mailResult(id: string, title: string, rank: number): PaletteResult {
    return {
        kind: 'mail',
        id,
        title,
        icon: Mail,
        group: 'mail',
        rank,
        payload: {} as EmailSummary,
        run: () => {},
    };
}

function smart(id: string, title: string, opts: { deterministic?: boolean } = {}): PaletteResult {
    return {
        kind: 'smart',
        id,
        title,
        icon: Mail,
        group: 'top-hit',
        rank: 0,
        deterministic: opts.deterministic,
        run: () => {},
    };
}

describe('buildSections', () => {
    test('caps each section at 6 items', () => {
        const actions = Array.from({ length: 10 }, (_, i) => action(`a${i}`, `Action ${i}`, -i));
        const mails = Array.from({ length: 10 }, (_, i) => mailResult(`m${i}`, `Mail ${i}`, -i));
        const sections = buildSections({
            action: actions,
            contact: [],
            smart: [],
            mail: mails,
            input: 'foo',
            scope: undefined,
        });
        expect(sections.groups.find((g) => g.id === 'actions')?.items.length).toBe(6);
        expect(sections.groups.find((g) => g.id === 'mail')?.items.length).toBe(6);
    });

    test('empty sections collapse', () => {
        const sections = buildSections({
            action: [action('a1', 'A1', 0)],
            contact: [],
            smart: [],
            mail: [],
            input: 'foo',
            scope: undefined,
        });
        expect(sections.groups.map((g) => g.id)).toEqual(['actions']);
    });

    test('a deterministic smart parse claims the Top Hit', () => {
        const det = smart('smart.mail-to', 'Mail to alice@example.com', { deterministic: true });
        const sections = buildSections({
            action: [],
            contact: [],
            smart: [det],
            mail: [],
            input: 'alice@example.com',
            scope: undefined,
        });
        expect(sections.topHit?.id).toBe('smart.mail-to');
    });

    test('an exact title match becomes the Top Hit', () => {
        const exact = action('a.exact', 'New document', 0);
        const sections = buildSections({
            action: [exact],
            contact: [],
            smart: [],
            mail: [mailResult('m1', 'something else', 0)],
            input: 'new document',
            scope: undefined,
        });
        expect(sections.topHit?.id).toBe('a.exact');
    });

    test('no Top Hit when nothing clears the structural bar', () => {
        const sections = buildSections({
            action: [action('a1', 'New document', 0)],
            contact: [],
            smart: [],
            mail: [mailResult('m1', 'thing', 0)],
            input: 'xyz',
            scope: undefined,
        });
        expect(sections.topHit).toBeUndefined();
    });

    test('scope=mail keeps only the mail group', () => {
        const sections = buildSections({
            action: [action('a1', 'A1', 0)],
            contact: [],
            smart: [],
            mail: [mailResult('m1', 'M1', 0)],
            input: 'foo',
            scope: 'mail',
        });
        expect(sections.groups.map((g) => g.id)).toEqual(['mail']);
    });

    test('scope=actions keeps only the actions group', () => {
        const sections = buildSections({
            action: [action('a1', 'A1', 0)],
            contact: [],
            smart: [],
            mail: [mailResult('m1', 'M1', 0)],
            input: 'foo',
            scope: 'actions',
        });
        expect(sections.groups.map((g) => g.id)).toEqual(['actions']);
    });

    test('empty input renders only the suggested section (curated actions)', () => {
        const actions = [
            { ...action('nav.mail', 'Go to Mail', 0), keywords: ['suggested'] },
            { ...action('a1', 'A1', 0) },
        ];
        const sections = buildSections({
            action: actions,
            contact: [],
            smart: [],
            mail: [],
            input: '',
            scope: undefined,
            suggestedCommandIds: ['nav.mail'],
        });
        expect(sections.groups.map((g) => g.id)).toEqual(['suggested']);
        expect(sections.groups[0].items.map((i) => i.id)).toEqual(['nav.mail']);
    });
});
