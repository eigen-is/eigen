import { describe, expect, test } from 'bun:test';
import { commentCardIdsIn } from '../../../docs/eigendoc';

const paragraph = (...content: object[]) => ({ type: 'paragraph', content });

describe('commentCardIdsIn', () => {
    test('finds a card on text by its comment mark and on a node by its commentCardId, at any depth', () => {
        const json = {
            type: 'doc',
            content: [
                paragraph(
                    {
                        type: 'text',
                        text: 'Marked',
                        marks: [{ type: 'bold' }, { type: 'comment', attrs: { cardId: 'c-mark' } }],
                    },
                    { type: 'figure', attrs: { mediaName: 'a.png', commentCardId: 'c-figure' } },
                ),
                paragraph({
                    type: 'textBox',
                    attrs: { commentCardId: 'c-box' },
                    content: [paragraph({ type: 'equation', attrs: { mathml: '', commentCardId: 'c-equation' } })],
                }),
            ],
        };
        expect([...commentCardIdsIn(json)].sort()).toEqual(['c-box', 'c-equation', 'c-figure', 'c-mark']);
    });

    test('reads every fragment it is given, such as the body and a band', () => {
        const body = { type: 'doc', content: [paragraph({ type: 'chart', attrs: { commentCardId: 'c-chart' } })] };
        const band = { type: 'doc', content: [paragraph({ type: 'figure', attrs: { commentCardId: 'c-band' } })] };
        expect([...commentCardIdsIn([body, band])].sort()).toEqual(['c-band', 'c-chart']);
    });

    test('a node with no card, or a mark of another kind, anchors none', () => {
        const json = {
            type: 'doc',
            content: [
                paragraph(
                    { type: 'figure', attrs: { mediaName: 'a.png', commentCardId: null } },
                    { type: 'text', text: 'Linked', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
                    { type: 'text', text: 'Empty', marks: [{ type: 'comment', attrs: { cardId: '' } }] },
                ),
            ],
        };
        expect([...commentCardIdsIn(json)]).toEqual([]);
    });
});
