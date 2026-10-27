import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { DOCUMENT_FONT, DOCUMENT_FONT_SIZE } from '../../../constants/fonts';
import { restoreYjsDoc } from '../../../core/collab/yjs-utils';
import type { NormalStyle } from '../../../docs/eigendoc';
import {
    DEFAULT_NORMAL_STYLE,
    DOCUMENT_PARAGRAPH_FORMAT,
    normalStyleProperties,
    readNormalStyle,
    STYLE_ROOT,
} from '../../../docs/eigendoc';
import { EIGEN_DOC_TYPE_INFO } from '../../../types/drive';

// Every key apart from Eigen's, so no read can hide a default.
const WORD_2013: NormalStyle = {
    font: 'Source Serif 4',
    size: 12,
    lineSpacing: 1.08,
    spaceBefore: 6,
    spaceAfter: 8,
    color: '#000000',
};

describe('the Normal style', () => {
    test("the default is Eigen's own look: Inter, 11 pt, line spacing 1.4, nothing before, 11 pt after, the body colour", () => {
        expect(DEFAULT_NORMAL_STYLE).toEqual({
            font: DOCUMENT_FONT,
            size: DOCUMENT_FONT_SIZE,
            lineSpacing: DOCUMENT_PARAGRAPH_FORMAT.lineSpacing,
            spaceBefore: DOCUMENT_PARAGRAPH_FORMAT.spaceBefore,
            spaceAfter: DOCUMENT_PARAGRAPH_FORMAT.spaceAfter,
            color: '#1a1a2e',
        });
    });

    test('a stored style reads back unchanged, and an empty map is the default', () => {
        expect(readNormalStyle({ ...WORD_2013 })).toEqual(WORD_2013);
        expect(readNormalStyle({})).toEqual(DEFAULT_NORMAL_STYLE);
    });

    test('a forged key reads as its default: an unbundled or CSS font, a non-number, a colour that is no hex', () => {
        expect(
            readNormalStyle({
                font: "'Comic Sans MS'; color: red",
                size: '12pt',
                lineSpacing: Number.NaN,
                spaceBefore: null,
                spaceAfter: Number.POSITIVE_INFINITY,
                color: 'red; background: url(x)',
            }),
        ).toEqual(DEFAULT_NORMAL_STYLE);
        expect(readNormalStyle({ font: 'Calibri', color: '#ABCDEF' })).toEqual(DEFAULT_NORMAL_STYLE);
    });

    // Eigen's writers store six lower-case digits, and a stored Normal reads as it always has.
    test.each(['#abc', '#abcd', '#aabbccdd', '#ABCDEF', 'rgb(1, 2, 3)', '#abcdef '])(
        'the color %p reads as the default',
        (color) => {
            expect(readNormalStyle({ color }).color).toBe(DEFAULT_NORMAL_STYLE.color);
        },
    );

    test('a color of six lower-case hex digits reads as itself', () => {
        expect(readNormalStyle({ color: '#abcdef' }).color).toBe('#abcdef');
    });

    test("each number is clamped and stepped as a paragraph's and a run's are", () => {
        expect(
            readNormalStyle({ size: 1000, lineSpacing: 9, spaceBefore: -5, spaceAfter: 500, color: '#123456' }),
        ).toEqual({
            ...DEFAULT_NORMAL_STYLE,
            size: 400,
            lineSpacing: 5,
            spaceBefore: 0,
            spaceAfter: 400,
            color: '#123456',
        });
        expect(readNormalStyle({ size: 10.3, lineSpacing: 1.157, spaceAfter: 7.98 })).toMatchObject({
            size: 10.5,
            lineSpacing: 1.16,
            spaceAfter: 8,
        });
    });

    test('the page draws only what sets a Normal apart from the default, so a doc without the map renders as before', () => {
        expect(normalStyleProperties(DEFAULT_NORMAL_STYLE)).toEqual({});
        expect(normalStyleProperties({ ...DEFAULT_NORMAL_STYLE, size: 12 })).toEqual({ '--doc-font-size': '12pt' });
        expect(normalStyleProperties(WORD_2013)).toEqual({
            '--doc-font-family': "'Source Serif 4', serif",
            '--doc-font-size': '12pt',
            '--doc-line-height': '1.3068',
            '--doc-space-before': '6pt',
            '--doc-space-after': '8pt',
            '--doc-color': '#000000',
        });
    });

    test('the style root is in the doc roots, so restoring a version from before it restores the default', () => {
        expect(EIGEN_DOC_TYPE_INFO.doc.yjsRoots[STYLE_ROOT]).toBe('map');
        const old = new Y.Doc();
        old.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);

        const live = new Y.Doc();
        Y.applyUpdate(live, Y.encodeStateAsUpdate(old));
        const style = live.getMap(STYLE_ROOT);
        for (const [key, value] of Object.entries(WORD_2013)) style.set(key, value);
        expect(readNormalStyle(style.toJSON())).toEqual(WORD_2013);

        restoreYjsDoc(live, Y.encodeStateAsUpdate(old), EIGEN_DOC_TYPE_INFO.doc.yjsRoots);
        expect(readNormalStyle(live.getMap(STYLE_ROOT).toJSON())).toEqual(DEFAULT_NORMAL_STYLE);

        const styled = new Y.Doc();
        for (const [key, value] of Object.entries(WORD_2013)) styled.getMap(STYLE_ROOT).set(key, value);
        restoreYjsDoc(live, Y.encodeStateAsUpdate(styled), EIGEN_DOC_TYPE_INFO.doc.yjsRoots);
        expect(readNormalStyle(live.getMap(STYLE_ROOT).toJSON())).toEqual(WORD_2013);
    });
});
