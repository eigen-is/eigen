import { describe, expect, it } from 'bun:test';
import { buildSearchRegex } from '@workspace/lib/doc-search';
import { searchDeck } from '../../../components/slides/search-deck';
import { DEFAULT_IMAGE_OBJECT, DEFAULT_TEXT_OBJECT, type DeckData } from '../../../components/slides/types';

const OPTS = { matchCase: false, wholeWord: false, regex: false };
function re(q: string, opts = OPTS): RegExp {
    const regex = buildSearchRegex(q, opts);
    if (!regex) throw new Error(`buildSearchRegex(${q}) returned null`);
    return regex;
}

function textObj(id: string, slideId: string, text: string) {
    return { ...DEFAULT_TEXT_OBJECT, id, slideId, text };
}

const deck: DeckData = {
    slideOrder: ['s1', 's2'],
    slides: {
        s1: { id: 's1', objectIds: ['o1', 'o2'], background: null },
        s2: { id: 's2', objectIds: ['o3', 'o4'], background: null },
    },
    objects: {
        o1: textObj('o1', 's1', '<p>Q3 launch<br>plan</p>'),
        o2: textObj('o2', 's1', '<p>Budget review</p>'),
        o3: textObj('o3', 's2', '<p>launch retro</p>'),
        o4: { ...DEFAULT_IMAGE_OBJECT, id: 'o4', slideId: 's2', mediaName: 'x.png' },
    },
};

describe('searchDeck', () => {
    it('matches one per text object, in slide order, with the slide as context', () => {
        expect(searchDeck(deck, re('launch'))).toEqual([
            { id: 'o1', label: 'Q3 launch plan', context: 'Slide 1' },
            { id: 'o3', label: 'launch retro', context: 'Slide 2' },
        ]);
    });

    it('keeps block/<br> boundaries as newlines so whole-word works across lines', () => {
        // div.textContent would glue this to "launchplan" and \blaunch\b would miss o1.
        expect(searchDeck(deck, re('launch', { ...OPTS, wholeWord: true })).map((m) => m.id)).toEqual(['o1', 'o3']);
    });

    it('returns [] when nothing matches', () => {
        expect(searchDeck(deck, re('zzz'))).toEqual([]);
    });
});
