// A figure, a table and a paste measure the text column of the page they sit on, a band's as the body's.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { textColumnWidth } = await import('../../../../components/docs/extensions/text-column');

afterEach(() => document.body.replaceChildren());

function page(width: number) {
    const element = document.body.appendChild(document.createElement('div'));
    element.setAttribute('data-document', '');
    element.style.padding = '0 50px';
    Object.defineProperty(element, 'clientWidth', { value: width });
    return element;
}

test('a node on the page measures its text column', () => {
    const inside = page(700).appendChild(document.createElement('p'));
    expect(textColumnWidth(inside)).toBe(600);
});

test('a node off the page has no column', () => {
    page(700);
    expect(textColumnWidth(document.body.appendChild(document.createElement('p')))).toBeNull();
    expect(textColumnWidth(null)).toBeNull();
});
