import { expect, test } from 'bun:test';
import { fromDom } from '../dom';
import { el } from './parse';

test('fromDom keeps namespaces, attributes as written, and text', () => {
    const element = el('<m:oMath xmlns:m="urn:m"><m:r m:val="1">a<!--c--><?pi x?>b</m:r></m:oMath>');
    expect(element.ns).toBe('urn:m');
    expect(element.local).toBe('oMath');
    const [run] = element.children;
    expect(run).toMatchObject({ ns: 'urn:m', local: 'r', attributes: { 'm:val': '1' }, children: ['a', 'b'] });
});

// happy-dom's parser has no CDATA sections; a browser DOM does, and they hold text.
test('fromDom reads CDATA as text and drops comments and processing instructions', () => {
    const node = (nodeType: number, nodeValue: string) => ({ nodeType, nodeValue });
    const element = fromDom({
        nodeType: 1,
        nodeValue: null,
        namespaceURI: null,
        localName: 'mi',
        attributes: [],
        childNodes: [node(4, 'a<b'), node(8, 'comment'), node(7, 'data'), node(3, '!')],
    });
    expect(element).toMatchObject({ ns: '', local: 'mi', children: ['a<b', '!'] });
});
