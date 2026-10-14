// A figure, a table and a paste measure the page's text column. A band's editor in the Headers and footers panel sits
// off the page, and its content prints in the same column, so it measures the page too.
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

test("a node off the page measures the page's text column", () => {
    page(700);
    const panel = document.body.appendChild(document.createElement('div'));
    expect(textColumnWidth(panel.appendChild(document.createElement('p')))).toBe(600);
});

test('with no page laid out there is no column', () => {
    expect(textColumnWidth(document.body.appendChild(document.createElement('p')))).toBeNull();
    expect(textColumnWidth(null)).toBeNull();
});
