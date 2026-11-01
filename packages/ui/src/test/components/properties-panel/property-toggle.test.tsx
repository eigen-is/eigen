import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderInDocument } = await import('../../render-in-document');
const { PropertyToggle } = await import('../../../components/properties-panel/property-toggle');

let unmount = async () => {};
afterEach(() => unmount());

// A caller sets it as an element attribute, which createElement's props type leaves out.
const mixed = { 'data-mixed': '' };

test('a mixed toggle draws its mixed state from its data-mixed attribute', async () => {
    ({ unmount } = await renderInDocument(
        createElement(PropertyToggle, { 'aria-label': 'Bold', pressed: false, ...mixed }),
    ));
    const toggle = document.querySelector('button[aria-label="Bold"]');
    expect(toggle?.hasAttribute('data-mixed')).toBe(true);
    expect(toggle?.classList.contains('data-[mixed]:border-dashed')).toBe(true);
});
