// A list page opens its detail only once something is selected. Without a selection the list takes the
// whole width and there is no detail column at all; with one the list narrows to its fixed width beside
// the detail. The detail is a detail column: its X and Esc close it, and on a phone, where only one of the
// two shows, its lone back closes it instead of the X.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement } = await import('react');
const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { ListDetailLayout } = await import('../../../../components/layout/app/list-detail-layout');

let unmount = async () => {};
afterEach(() => unmount());

const onClose = mock(() => {});

async function render(selected: boolean, isMobile = false) {
    await unmount();
    onClose.mockClear();
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
        onClose,
        children: 'The list',
    });
    const rendered = await renderInDocument(createElement(LayoutContext.Provider, { value: layout }, page));
    unmount = rendered.unmount;
    const container = rendered.container;
    const layoutRow = container.firstElementChild;
    const list = layoutRow?.firstElementChild;
    return {
        text: container.textContent ?? '',
        columns: layoutRow?.childElementCount ?? 0,
        listWidth: list instanceof HTMLElement ? list.style.width : '',
        listGrow: list instanceof HTMLElement ? list.style.flexGrow : '',
        close: container.querySelector<HTMLButtonElement>('button[aria-label="Close"]'),
        back: container.querySelector<HTMLButtonElement>('[data-slot="detail-column"] button[aria-label="Back"]'),
    };
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
    expect(listWidth).toBe('400px');
    expect(listGrow).toBe('');
});

test('on a desktop the X closes the detail', async () => {
    expect((await render(false)).close).toBeNull();
    const { close } = await render(true);
    await act(async () => close?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('Esc closes the detail', async () => {
    await render(true);
    await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('on a phone the lone back closes the detail, and there is no X', async () => {
    const { close, back } = await render(true, true);
    expect(close).toBeNull();
    await act(async () => back?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('on a phone the list shows until a selection, then only the detail', async () => {
    const list = await render(false, true);
    expect(list.text).toContain('The list');
    expect(list.text).not.toContain('The detail');

    const detail = await render(true, true);
    expect(detail.text).toContain('The detail');
    expect(detail.text).not.toContain('The list');
});
