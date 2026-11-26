// On a phone an open detail covers the page's main, which stays mounted under it, so an editor keeps its document across
// open, close and open again. A desktop shows the main alone, since its host puts the detail in its own right slot.
import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

const { act, createElement, useEffect, useState } = await import('react');
const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { PhoneDetail } = await import('../../../../components/layout/app/phone-detail');

let unmount = async () => {};
afterEach(() => unmount());

let mounts = 0;
let setOpen: (open: boolean) => void = () => {};

function Main() {
    useEffect(() => {
        mounts++;
    }, []);
    return 'Main';
}

function Page() {
    const [open, setOpenState] = useState(false);
    setOpen = setOpenState;
    return createElement(PhoneDetail, { detail: open ? 'Detail' : undefined, children: createElement(Main) });
}

async function render(isMobile: boolean) {
    mounts = 0;
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
    const rendered = await renderInDocument(
        createElement(LayoutContext.Provider, { value: layout }, createElement(Page)),
    );
    unmount = rendered.unmount;
    const main = () => [...rendered.container.querySelectorAll('div')].find((el) => el.textContent === 'Main');
    return { text: () => rendered.container.textContent, hidden: () => main()?.classList.contains('hidden') };
}

test('on a phone the detail covers the main, which keeps its one mount', async () => {
    const page = await render(true);
    await act(async () => setOpen(true));
    expect(page.text()).toBe('MainDetail');
    expect(page.hidden()).toBe(true);
    await act(async () => setOpen(false));
    expect(page.text()).toBe('Main');
    expect(page.hidden()).toBe(false);
    await act(async () => setOpen(true));
    expect(mounts).toBe(1);
});

test('a desktop shows the main alone, which keeps its one mount', async () => {
    const page = await render(false);
    await act(async () => setOpen(true));
    expect(page.text()).toBe('Main');
    expect(page.hidden()).toBe(false);
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    expect(mounts).toBe(1);
});
