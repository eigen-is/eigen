// A list page opens its detail only once something is selected. Without a selection the list takes the
// whole width and there is no detail column at all; with one the list narrows to its fixed width beside
// the detail, and a Close button in the detail's toolbar takes the page back to the list. On a phone only
// one of the two shows, the list or the selected item's detail, and the back arrow replaces Close.
import { expect, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { createElement } = await import('react');
const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { ListDetailLayout } = await import('../../../../components/layout/app/list-detail-layout');

type Shown = { text: string; columns: number; listWidth: string; listGrow: string; close: boolean };

async function render(selected: boolean, isMobile = false): Promise<Shown> {
    const layout = {
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
        isTablet: false,
    };
    const page = createElement(ListDetailLayout, {
        listToolbar: 'List toolbar',
        detail: selected ? 'The detail' : undefined,
        detailToolbar: selected ? 'Detail toolbar' : undefined,
        onBackToList: () => {},
        children: 'The list',
    });
    const { container, unmount } = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layout }, page),
    );
    const layoutRow = container.firstElementChild;
    const list = layoutRow?.firstElementChild;
    const shown = {
        text: container.textContent ?? '',
        columns: layoutRow?.childElementCount ?? 0,
        listWidth: list instanceof HTMLElement ? list.style.width : '',
        listGrow: list instanceof HTMLElement ? list.style.flexGrow : '',
        close: container.querySelector('button[aria-label="Close"]') !== null,
    };
    await unmount();
    return shown;
}

test('without a selection the list fills the width and there is no detail', async () => {
    const { text, columns, listWidth, listGrow } = await render(false);
    expect(columns).toBe(1);
    expect(text).toContain('The list');
    expect(text).not.toContain('Detail toolbar');
    expect(listGrow).toBe('1');
    expect(listWidth).toBe('');
});

test('a selection opens the detail beside a list of fixed width', async () => {
    const { text, columns, listWidth, listGrow } = await render(true);
    expect(columns).toBe(2);
    expect(text).toContain('The list');
    expect(text).toContain('Detail toolbar');
    expect(text).toContain('The detail');
    expect(listWidth).toBe('350px');
    expect(listGrow).toBe('');
});

test('the detail closes from its toolbar on a desktop, and from the back arrow on a phone', async () => {
    expect((await render(false)).close).toBe(false);
    expect((await render(true)).close).toBe(true);
    expect((await render(true, true)).close).toBe(false);
});

test('on a phone the list shows until a selection, then only the detail', async () => {
    const list = await render(false, true);
    expect(list.text).toContain('The list');
    expect(list.text).not.toContain('The detail');

    const detail = await render(true, true);
    expect(detail.text).toContain('The detail');
    expect(detail.text).not.toContain('The list');
});
