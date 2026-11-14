// The landing page's line of apps reads the same on every server, and each app word links to that app's About page
// once the page is written. The pages come from the built manifest, which has the sheets page.
import { describe, expect, test } from 'bun:test';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingApps } from '../../components/landing-apps';

describe('LandingApps', () => {
    test('links only the apps that have an About page, in the same words', async () => {
        const router = createRouter({
            routeTree: createRootRoute({ component: () => <LandingApps /> }),
            history: createMemoryHistory({ initialEntries: ['/'] }),
        });
        await router.load();
        const html = renderToStaticMarkup(<RouterProvider router={router} />);
        expect(html.match(/href="[^"]+"/g)).toEqual(['href="/about/sheets"']);
        expect(html.replace(/<[^>]+>/g, '')).toBe(
            'Mail, drive, docs, sheets, slides, drawings, stickies, calendar, contacts and chat.',
        );
    });
});
