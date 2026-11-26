// A side column picks its width by name: small is 256, medium 320 and large 400, which steps down to 320 on a tablet,
// while flex takes the room that is left, and a host that lays out around a column reads the same number from the
// layout. On a phone every column fills the screen and its back is a lone chevron named "Back".
import { expect, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { Column } = await import('../../../../components/layout/app/column-layout');
const { columnWidthPx, useColumnWidthPx } = await import('../../../../components/layout/app/column-widths');

type Width = 'flex' | 'small' | 'medium' | 'large';

const layoutFor = ({ isMobile = false, isTablet = false }) => ({
    appName: '',
    setAppName: () => {},
    documentTitle: '',
    setDocumentTitle: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarColumnShown: false,
    sidebarMode: 'collapsible' as const,
    sidebarHidden: false,
    setSidebarHidden: () => {},
    isMobile,
    isTablet,
});

async function render(width: Width, { isMobile = false, isTablet = false } = {}) {
    const column = createElement(Column, { id: 'c', width, onBack: () => {}, children: 'Body' });
    const { container, unmount } = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layoutFor({ isMobile, isTablet }) }, column),
    );
    const el = container.firstElementChild;
    const shown = {
        width: el instanceof HTMLElement ? el.style.width : '',
        grow: el instanceof HTMLElement ? el.style.flexGrow : '',
        back: container.querySelector('button[aria-label="Back"]')?.textContent,
    };
    await unmount();
    return shown;
}

test('each fixed size has one width, and only large steps down on a tablet', () => {
    expect(columnWidthPx('small')).toBe(256);
    expect(columnWidthPx('medium')).toBe(320);
    expect(columnWidthPx('large')).toBe(400);
    expect(columnWidthPx('small', true)).toBe(256);
    expect(columnWidthPx('medium', true)).toBe(320);
    expect(columnWidthPx('large', true)).toBe(320);
});

// The width a host reads in React, as the page's layout gives it.
async function hostWidth(width: Exclude<Width, 'flex'>, isTablet: boolean) {
    function Host() {
        return useColumnWidthPx(width);
    }
    const { container, unmount } = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layoutFor({ isTablet }) }, createElement(Host)),
    );
    const shown = Number(container.textContent);
    await unmount();
    return shown;
}

test('a host reads the width a column of a size draws, tablet step included', async () => {
    expect(await hostWidth('small', false)).toBe(256);
    expect(await hostWidth('medium', false)).toBe(320);
    expect(await hostWidth('large', false)).toBe(400);
    expect(await hostWidth('small', true)).toBe(256);
    expect(await hostWidth('medium', true)).toBe(320);
    expect(await hostWidth('large', true)).toBe(320);
});

test('a column draws its size at its width, and flex grows', async () => {
    expect((await render('small')).width).toBe('256px');
    expect((await render('medium')).width).toBe('320px');
    expect((await render('large')).width).toBe('400px');
    expect((await render('large', { isTablet: true })).width).toBe('320px');
    const flex = await render('flex');
    expect(flex.width).toBe('');
    expect(flex.grow).toBe('1');
});

test('on a phone a column fills the screen with a back named Back, and a desktop has none', async () => {
    const phone = await render('large', { isMobile: true });
    expect(phone.width).toBe('100%');
    expect(phone.back).toBe('');
    expect((await render('large')).back).toBeUndefined();
});
