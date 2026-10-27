// The space index shows an Admin tile to an admin only, and every tile wears its app's color.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import type { ReactNode } from 'react';

// The router and the UI read the window while they load, and every later test file in this run gets the
// modules this one loads, so they load in a browser here too.
installHappyDom();

let isAdmin = false;
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({ ...realAdmin, useIsAdmin: () => isAdmin }));

const { apps } = await import('@workspace/lib/apps');
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({ ...realPublic, useEnabledApps: () => apps }));

// The page chrome needs a layout context this test has no use for, so it renders as its children.
const passThrough = ({ children }: { children: ReactNode }) => children;
const realUi = { ...(await import('@workspace/ui')) };
mock.module('@workspace/ui', () => ({
    ...realUi,
    ColumnLayout: passThrough,
    Column: passThrough,
    EigenCyclingLogo: () => null,
    KetTile: ({ title, color }: { title: string; color: string }) => <h3 data-color={color}>{title}</h3>,
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/lib/public', () => realPublic);
    mock.module('@workspace/ui', () => realUi);
});

const { renderToStaticMarkup } = await import('react-dom/server');
const { Route } = await import('../../routes/_auth.index');

// Each tile's title mapped to its color.
function tiles(): Record<string, string> {
    const Home = Route.options.component;
    if (!Home) throw new Error('the space index route has no component');
    const html = renderToStaticMarkup(<Home />);
    return Object.fromEntries([...html.matchAll(/<h3 data-color="([^"]*)">([^<]*)<\/h3>/g)].map(([, c, t]) => [t, c]));
}

describe('space index tiles', () => {
    beforeEach(() => {
        isAdmin = false;
    });

    test('an admin sees the Admin tile in the admin color', () => {
        isAdmin = true;
        expect(tiles().Admin).toBe('var(--app-admin-color)');
    });

    test('a user sees no Admin tile', () => {
        expect(tiles()).not.toHaveProperty('Admin');
    });

    test('the help tile wears the help center teal', () => {
        expect(tiles()['Help and support']).toBe('var(--app-space-color)');
    });

    test('an app tile wears its app color', () => {
        expect(tiles().Mail).toBe('var(--app-mail-color)');
    });
});
