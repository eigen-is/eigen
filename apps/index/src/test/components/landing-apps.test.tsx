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
        expect(html.match(/href="[^"]+"/g)).toEqual([
            'href="/about/mail"',
            'href="/about/docs"',
            'href="/about/sheets"',
            'href="/about/slides"',
            'href="/about/vector"',
            'href="/about/calendar"',
        ]);
        expect(html.replace(/<[^>]+>/g, '')).toBe(
            'Mail, drive, docs, sheets, slides, drawings, stickies, calendar, contacts and chat.',
        );
    });
});
