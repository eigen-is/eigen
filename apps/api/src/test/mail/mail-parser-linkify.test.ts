import { describe, expect, test } from 'bun:test';
import { textToHtml } from '../../lib/mail/mail-parser/html';
import { findLinks } from '../../lib/mail/mail-parser/linkify';

function hrefs(text: string): string[] {
    return findLinks(text).map((link) => link.href);
}

function linked(text: string): string[] {
    return findLinks(text).map((link) => text.slice(link.start, link.end));
}

describe('findLinks', () => {
    test('http(s) and mailto: URLs link as written', () => {
        expect(hrefs('See http://example.com and https://example.com/path?q=1 or mailto:sales@example.com')).toEqual([
            'http://example.com',
            'https://example.com/path?q=1',
            'mailto:sales@example.com',
        ]);
    });

    test('a link at the very start and the very end of the text', () => {
        expect(linked('https://example.com/start then https://example.com/end')).toEqual([
            'https://example.com/start',
            'https://example.com/end',
        ]);
    });

    test('bare e-mail addresses become mailto: links', () => {
        expect(hrefs('Mail first.last+tag@sub.example.com today')).toEqual(['mailto:first.last+tag@sub.example.com']);
    });

    test('www. hosts get an http:// href; bare domains are not guessed', () => {
        expect(findLinks('Docs: www.example.com/docs#top, not example.com or mail.example.com')).toEqual([
            { start: 6, end: 30, href: 'http://www.example.com/docs#top' },
        ]);
    });

    test('Bluesky handles link to the profile; an e-mail address is never also a handle', () => {
        expect(findLinks('Follow @reinder.bsky.social. Mail hello@example.com, not @@nope or foo@@bar')).toEqual([
            { start: 7, end: 27, href: 'https://bsky.app/profile/reinder.bsky.social' },
            { start: 34, end: 51, href: 'mailto:hello@example.com' },
        ]);
    });

    test('a URL does not start in the middle of a word', () => {
        expect(hrefs('xhttps://example.com foo.www.example.com')).toEqual([]);
    });

    test('trailing sentence punctuation stays outside the link', () => {
        expect(
            linked(
                'Go to https://example.com/a. Or https://example.com/b, https://example.com/c; ok? https://example.com/d!',
            ),
        ).toEqual(['https://example.com/a', 'https://example.com/b', 'https://example.com/c', 'https://example.com/d']);
    });

    test('closing brackets are trimmed only when unbalanced', () => {
        expect(
            linked(
                '(see https://example.com/a) and https://en.wikipedia.org/wiki/Foo_(bar)) and [https://example.com/b]',
            ),
        ).toEqual(['https://example.com/a', 'https://en.wikipedia.org/wiki/Foo_(bar)', 'https://example.com/b']);
    });

    test('quotes and angle brackets delimit a URL', () => {
        expect(linked('<https://example.com/a> "https://example.com/b" \'https://example.com/c\'')).toEqual([
            'https://example.com/a',
            'https://example.com/b',
            'https://example.com/c',
        ]);
    });

    test('non-ASCII path characters are part of the URL', () => {
        expect(linked('https://example.com/über?q=ü')).toEqual(['https://example.com/über?q=ü']);
    });

    test('a body full of addresses links in linear time', () => {
        const text = 'a@example.com b@example.com '.repeat(1500);
        const started = performance.now();
        expect(findLinks(text)).toHaveLength(3000);
        expect(performance.now() - started).toBeLessThan(500);
    });
});

describe('textToHtml', () => {
    test('encodes the href and the surrounding text', () => {
        expect(textToHtml('A & B: https://example.com/?x=1&y=2 <ok>')).toBe(
            '<p>A &amp; B: <a href="https://example.com/?x=1&amp;y=2">https://example.com/?x=1&amp;y=2</a> &lt;ok&gt;</p>',
        );
    });

    test('a body without links is only encoded', () => {
        expect(textToHtml('Plain "text"\n\nsecond paragraph')).toBe(
            '<p>Plain &quot;text&quot;</p><p>second paragraph</p>',
        );
    });
});
