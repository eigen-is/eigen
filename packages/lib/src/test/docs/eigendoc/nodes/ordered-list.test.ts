import { describe, expect, test } from 'bun:test';
import { createDocument, generateHTML, getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions } from '../../../../docs/eigendoc';
import { installHappyDom } from '../../../happy-dom';

// generateHTML serializes through `document`, createDocument parses with DOMParser.
installHappyDom();

const extensions = getDocExtensions();
const listDoc = (attrs: Record<string, unknown>): JSONContent => ({
    type: 'doc',
    content: [
        {
            type: 'orderedList',
            attrs,
            content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }] }],
        },
    ],
});

const olOf = (attrs: Record<string, unknown>) => {
    const host = document.createElement('div');
    host.innerHTML = generateHTML(listDoc(attrs), extensions);
    const ol = host.querySelector('ol');
    if (!ol) throw new Error('no ol');
    return ol;
};

describe('ordered list HTML', () => {
    // Chrome matches `type` case-blind and reads no `s` flag, so a stylesheet can't tell `a` from `A`.
    test.each([
        ['a', 'lower-alpha'],
        ['A', 'upper-alpha'],
        ['i', 'lower-roman'],
        ['I', 'upper-roman'],
    ])('a list of type %s draws %s on itself and keeps the type', (type, style) => {
        const ol = olOf({ type });
        expect(ol.getAttribute('type')).toBe(type);
        expect(ol.style.cssText).toBe(`list-style-type: ${style};`);
    });

    test('a list that starts past 1 sets its counter beside the start', () => {
        const ol = olOf({ start: 3, type: 'a' });
        expect(ol.getAttribute('start')).toBe('3');
        expect(ol.style.cssText).toBe('counter-reset: list-item 2; list-style-type: lower-alpha;');
    });

    test('a decimal list from 1 writes neither', () => {
        expect(olOf({ start: 1, type: '1' }).attributes).toHaveLength(0);
    });

    test('the HTML parses back to the same start and type', () => {
        const attrs: Record<string, unknown>[] = [];
        createDocument(generateHTML(listDoc({ start: 3, type: 'A' }), extensions), getSchema(extensions)).descendants(
            (node) => {
                if (node.type.name === 'orderedList') attrs.push(node.attrs);
            },
        );
        expect(attrs).toEqual([{ start: 3, type: 'A' }]);
    });
});
