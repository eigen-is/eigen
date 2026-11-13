// A visitor who is signed out sees a login icon in the top bar, named Enter demo on a demo server. It waits for
// the session check, so a signed-in visitor never sees it flash, and an empty app name gives the bare "eigen" wordmark.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getDemoEnterUrl, getSpaceAppUrl } from '@workspace/lib/api';
import type { ReactNode } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

let session = { isAuthenticated: false, isLoading: false, user: null };
let demoMode = false;
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => false }));
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicConfig: () => ({ data: { demoMode } }),
    useEnabledApps: () => [],
}));
// The bar sits outside a router here, so its links are plain anchors.
const realRouter = { ...(await import('@tanstack/react-router')) };
mock.module('@tanstack/react-router', () => ({
    ...realRouter,
    useRouter: () => ({}),
    Link: ({ to, children, className }: { to: string; children: ReactNode; className?: string }) => (
        <a href={to} className={className}>
            {children}
        </a>
    ),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@tanstack/react-router', () => realRouter);
});

const { LayoutContext } = await import('../../../../components/layout/app/layout-context');
const { Topbar } = await import('../../../../components/layout/app/topbar');

const layout = {
    appName: 'blog',
    setAppName: () => {},
    documentTitle: '',
    setDocumentTitle: () => {},
    sidebarOpen: false,
    setSidebarOpen: () => {},
    sidebarColumnShown: false,
    sidebarMode: 'none' as const,
    sidebarHidden: false,
    setSidebarHidden: () => {},
    isMobile: false,
    isTablet: false,
};

async function renderBar(appName = 'blog'): Promise<HTMLElement> {
    const { container } = await renderInDocument(
        <LayoutContext.Provider value={{ ...layout, appName }}>
            <Topbar rootRoute={{ useNavigate: () => () => {} }} />
        </LayoutContext.Provider>,
    );
    return container;
}

beforeEach(() => {
    session = { isAuthenticated: false, isLoading: false, user: null };
    demoMode = false;
});

// The bar's icon link, found by its accessible name.
function loginLink(bar: HTMLElement): HTMLAnchorElement | undefined {
    return [...bar.querySelectorAll('header a')].find(
        (link): link is HTMLAnchorElement =>
            link instanceof HTMLAnchorElement &&
            ['Login', 'Enter demo'].includes(link.getAttribute('aria-label') ?? ''),
    );
}

describe('the signed-out top bar', () => {
    test('shows a login icon that goes to Space', async () => {
        const link = loginLink(await renderBar());
        expect(link?.getAttribute('aria-label')).toBe('Login');
        expect(link?.getAttribute('href')).toBe(getSpaceAppUrl());
    });

    test('shows Enter demo, which goes to the demo entry, on a demo server', async () => {
        demoMode = true;
        const link = loginLink(await renderBar());
        expect(link?.getAttribute('aria-label')).toBe('Enter demo');
        expect(link?.getAttribute('href')).toBe(getDemoEnterUrl());
    });

    test('shows no button while the session is still loading', async () => {
        session = { isAuthenticated: false, isLoading: true, user: null };
        expect(loginLink(await renderBar())).toBeUndefined();
    });

    test('shows no button to a signed-in visitor', async () => {
        session = { isAuthenticated: true, isLoading: false, user: null };
        expect(loginLink(await renderBar())).toBeUndefined();
    });

    test('draws the bare wordmark and titles the page eigen when the app name is empty', async () => {
        const bar = await renderBar('');
        expect(bar.querySelector('header')?.textContent).not.toContain('|');
        expect(document.title).toBe('eigen');
    });
});
