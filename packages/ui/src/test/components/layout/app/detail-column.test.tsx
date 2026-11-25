// A detail column's bar names a list, never an item: a title alone over a list, "‹ Comments" once it drilled into one
// item, and on a phone a lone "‹" that closes the column. X closes it off the phone. Esc closes it too, unless a
// handler before it used the key, the focus is in a field or a dialog is open.
import { afterEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement, Fragment } = await import('react');
const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { DetailColumn } = await import('../../../../components/layout/app/detail-column');

let unmount = async () => {};
afterEach(() => unmount());

const onClose = mock(() => {});
const onBack = mock(() => {});

type Options = { isMobile?: boolean; title?: string; withBack?: boolean; extra?: ReturnType<typeof createElement> };

async function render({ isMobile = false, title, withBack = false, extra }: Options = {}) {
    onClose.mockClear();
    onBack.mockClear();
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
    const column = createElement(DetailColumn, {
        width: 'medium',
        title,
        onBack: withBack ? onBack : undefined,
        actions: 'Actions',
        onClose,
        children: 'Body',
    });
    const rendered = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layout }, createElement(Fragment, null, column, extra)),
    );
    unmount = rendered.unmount;
    const slot = rendered.container.querySelector('[data-slot="detail-column"]');
    const buttons = [...(slot?.querySelectorAll('button') ?? [])];
    return {
        bar: () => slot?.firstElementChild?.firstElementChild?.textContent,
        backs: () => buttons.filter((b) => b.querySelector('.lucide-chevron-left')),
        close: () => slot?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') ?? null,
    };
}

async function pressEscape(target: EventTarget = document.body, prevented = false) {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    if (prevented) event.preventDefault();
    await act(async () => {
        target.dispatchEvent(event);
    });
}

test('over a list the bar shows the title alone', async () => {
    const column = await render({ title: 'Comments' });
    expect(column.bar()).toBe('CommentsActions');
    expect(column.backs()).toHaveLength(0);
});

test('drilled into one item the bar shows a back named after the list', async () => {
    const column = await render({ title: 'Comments', withBack: true });
    const [back, ...more] = column.backs();
    expect(more).toHaveLength(0);
    expect(back?.textContent).toBe('Comments');
    await act(async () => back?.click());
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
});

test('X closes off the phone, and a phone has none', async () => {
    const desktop = await render();
    await act(async () => desktop.close()?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
    expect((await render({ isMobile: true })).close()).toBeNull();
});

test('on a phone a lone back closes the column, then the title', async () => {
    const column = await render({ isMobile: true, title: 'Comments' });
    const [back, ...more] = column.backs();
    expect(more).toHaveLength(0);
    expect(back?.getAttribute('aria-label')).toBe('Back');
    expect(column.bar()).toBe('CommentsActions');
    await act(async () => back?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('on a phone a column drilled into an item has one back, to the list', async () => {
    const column = await render({ isMobile: true, title: 'Comments', withBack: true });
    const [back, ...more] = column.backs();
    expect(more).toHaveLength(0);
    expect(back?.textContent).toBe('Comments');
});

test('Esc closes the column', async () => {
    await render();
    await pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
});

test('an Esc a handler before it used leaves the column open', async () => {
    await render();
    await pressEscape(document.body, true);
    expect(onClose).not.toHaveBeenCalled();
});

test('an Esc in a text field leaves the column open', async () => {
    await render({ extra: createElement('input', { 'aria-label': 'Field' }) });
    const field = document.querySelector('input[aria-label="Field"]');
    if (!(field instanceof HTMLInputElement)) throw new Error('no field');
    field.focus();
    await pressEscape(field);
    expect(onClose).not.toHaveBeenCalled();
});

test('an Esc while a dialog is open leaves the column open', async () => {
    await render({ extra: createElement('div', { role: 'dialog', 'data-state': 'open' }) });
    await pressEscape();
    expect(onClose).not.toHaveBeenCalled();
});
