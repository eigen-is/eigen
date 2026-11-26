// A visitor who is signed out sees a login icon in the top bar, named Enter demo on a demo server. It waits for
// the session check, so a signed-in visitor never sees it flash, and an empty app name gives the bare "eigen" wordmark.
// A signed-out visitor of a public document reads its name in the bar's middle, where a user has the palette.
// A signed-in user's avatar opens the account menu, which a guest gets without the rows only a user has.

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { getDemoEnterUrl, getSpaceAppUrl } from '@workspace/lib/api';
import type { ReactNode } from 'react';
import { installHappyDom } from '../../../happy-dom';
import { rowLabel } from '../../../menu-rows';
import { renderInDocument } from '../../../render-in-document';

installHappyDom();

type Session = { isAuthenticated: boolean; isLoading: boolean; user: { name: string; email: string } | null };
let session: Session = { isAuthenticated: false, isLoading: false, user: null };
let guest = false;
let demoMode = false;
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session, useIsGuest: () => guest }));
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

const { act } = await import('react');
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

async function renderBar(appName = 'blog', documentTitle = ''): Promise<HTMLElement> {
    const { container } = await renderInDocument(
        <LayoutContext.Provider value={{ ...layout, appName, documentTitle }}>
            <Topbar rootRoute={{ useNavigate: () => () => {} }} />
        </LayoutContext.Provider>,
    );
    return container;
}

beforeEach(() => {
    session = { isAuthenticated: false, isLoading: false, user: null };
    guest = false;
    demoMode = false;
});

// The bar's icon link, found by its accessible name.
function loginLink(bar: HTMLElement): HTMLAnchorElement | undefined {
    return [...bar.querySelectorAll('header a')].find(
        (link): link is HTMLAnchorElement =>
            link instanceof HTMLAnchorElement &&
            ['Log in', 'Enter demo'].includes(link.getAttribute('aria-label') ?? ''),
    );
}

describe('the signed-out top bar', () => {
    test('shows a login icon that goes to Space', async () => {
        const link = loginLink(await renderBar());
        expect(link?.getAttribute('aria-label')).toBe('Log in');
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

    test("shows an open document's name, which nothing edits", async () => {
        const bar = await renderBar('docs', 'Holiday plan');
        const title = [...bar.querySelectorAll('header span')].find((span) => span.textContent === 'Holiday plan');
        expect(title).toBeDefined();
        expect(bar.querySelector('header input')).toBeNull();
    });

    test('draws the bare wordmark and titles the page eigen when the app name is empty', async () => {
        const bar = await renderBar('');
        expect(bar.querySelector('header')?.textContent).not.toContain('|');
        expect(document.title).toBe('eigen');
    });
});

// The open account menu's rows as they are on the page, separators uncollapsed, each with its icon.
async function accountMenuRows(bar: HTMLElement): Promise<string[]> {
    const avatar = bar.querySelector('[data-slot="dropdown-menu-trigger"]');
    await act(async () => {
        avatar?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    });
    return [...(document.querySelector('[role="menu"]')?.children ?? [])].map((row) => {
        if (row.getAttribute('role') === 'separator') return '—';
        const classes = [...(row.querySelector('svg')?.classList ?? [])];
        const icon = classes.find((name) => name.startsWith('lucide-')) ?? 'logo';
        return row.getAttribute('data-slot') === 'dropdown-menu-label' ? 'name' : `${icon} ${rowLabel(row)}`;
    });
}

describe('the account menu', () => {
    beforeEach(() => {
        session = { isAuthenticated: true, isLoading: false, user: { name: 'Ada', email: 'ada@example.com' } };
    });

    test('gives a user the Space pages, the theme, Support, About Eigen and Log out', async () => {
        expect(await accountMenuRows(await renderBar())).toEqual([
            'name',
            '—',
            'lucide-user-round Profile',
            'lucide-settings Settings',
            'lucide-palette Theme',
            '—',
            'lucide-life-buoy Support',
            'logo About Eigen',
            '—',
            'lucide-log-out Log out',
        ]);
    });

    test('gives a guest Support, About Eigen and Log out', async () => {
        guest = true;
        expect(await accountMenuRows(await renderBar())).toEqual([
            'name',
            '—',
            'lucide-life-buoy Support',
            'logo About Eigen',
            '—',
            'lucide-log-out Log out',
        ]);
    });
});
