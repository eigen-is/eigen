import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { clickAdvances, presentStep } from '../../../components/slides/present-mode';

// A DOM at module scope, the canvas suites' recipe: the predicate walks up from the clicked node, so
// `instanceof Element` needs the constructor to be the global one.
const window = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.document = window.document;
g.Element = window.Element;

describe('presentStep', () => {
    test('a click advances', () => {
        expect(presentStep(0, 3, 1)).toBe(1);
    });

    test('a click past the last slide leaves present mode', () => {
        expect(presentStep(2, 3, 1)).toBe(-1);
    });

    test('going back from the first slide stays put — it never exits', () => {
        expect(presentStep(0, 3, -1)).toBe(0);
    });

    test('an empty deck has nowhere to go', () => {
        expect(presentStep(0, 0, 1)).toBe(-1);
    });
});

describe('clickAdvances', () => {
    const slide = (html: string) => {
        document.body.innerHTML = html;
        return document.body.firstElementChild as Element;
    };

    test('a click on the slide itself moves the deck on', () => {
        expect(clickAdvances(slide('<div><p>a slide</p></div>').querySelector('p'))).toBe(true);
    });

    test("a click on a link is the link's — the deck stays put", () => {
        expect(clickAdvances(slide('<div><a href="https://example.com">source</a></div>').querySelector('a'))).toBe(
            false,
        );
    });

    test('a click on text inside a link counts as the link', () => {
        const el = slide('<div><a href="https://example.com"><strong>source</strong></a></div>');
        expect(clickAdvances(el.querySelector('strong'))).toBe(false);
    });

    test('an anchor with no href is not a link', () => {
        expect(clickAdvances(slide('<div><a>not a link</a></div>').querySelector('a'))).toBe(true);
    });

    test('a target that is not an element advances', () => {
        expect(clickAdvances(null)).toBe(true);
    });
});
