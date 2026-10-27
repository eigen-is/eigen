// The space index shows an Admin tile to an admin only, and every tile wears its app's color.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

let isAdmin = false;
mock.module('@workspace/lib/admin', () => ({ useIsAdmin: () => isAdmin }));

const { apps } = await import('@workspace/lib/apps');
mock.module('@workspace/lib/public', () => ({ useEnabledApps: () => apps }));

// The page chrome needs a layout context this test has no use for, so it renders as its children.
const passThrough = ({ children }: { children: ReactNode }) => children;
mock.module('@workspace/ui', () => ({
    ColumnLayout: passThrough,
    Column: passThrough,
    EigenCyclingLogo: () => null,
    KetTile: ({ title, color }: { title: string; color: string }) => <h3 data-color={color}>{title}</h3>,
}));

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
