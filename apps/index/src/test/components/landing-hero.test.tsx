// The landing headline starts as "your own workspace" in the Space color, so the prerender and the first client
// render match, then cycles through the ten apps in the order the pitch line names them. Pointing at an app in that
// line shows it in the headline and holds the cycle; leaving lets it go on. Reduced motion never cycles.
import { afterAll, afterEach, describe, expect, jest, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';
import type { ReactNode } from 'react';

const happyDom = installHappyDom();

// The hero sits outside a router here, so its links are plain anchors.
const realRouter = await import('@tanstack/react-router');
mock.module('@tanstack/react-router', () => ({
    ...realRouter,
    Link: ({
        params,
        children,
        ...props
    }: { params: { section: string }; children: ReactNode } & Record<string, unknown>) => (
        <a {...props} href={`/support/${params.section}`}>
            {children}
        </a>
    ),
}));
afterAll(() => {
    mock.module('@tanstack/react-router', () => realRouter);
});

const { act } = await import('react');
const { LandingHero } = await import('../../components/landing-hero');

const ORDER = ['mail', 'drive', 'docs', 'sheets', 'slides', 'vector', 'stickies', 'calendar', 'contacts', 'chat'];

afterEach(() => {
    jest.useRealTimers();
});

async function renderHero(demoMode = false): Promise<HTMLElement> {
    jest.useFakeTimers();
    const { container } = await renderInDocument(<LandingHero demoMode={demoMode} />);
    return container;
}

const headline = (hero: HTMLElement) => hero.querySelector('h1')?.textContent;
const tick = (ms: number) => act(async () => void jest.advanceTimersByTime(ms));

describe('LandingHero', () => {
    test('starts as your own workspace in the Space color', async () => {
        const hero = await renderHero();
        expect(headline(hero)).toBe('your ownworkspace');
        expect(hero.querySelector('h1 span:last-child')?.getAttribute('style')).toContain('var(--app-space-color)');
    });

    test('links each app word to its Support section, drawings to vector', async () => {
        const links = [...(await renderHero()).querySelectorAll('p a')];
        expect(links.map((link) => link.getAttribute('href'))).toEqual(ORDER.map((id) => `/support/${id}`));
        expect(links.map((link) => link.textContent)).toEqual([
            'Mail',
            'drive',
            'docs',
            'sheets',
            'slides',
            'drawings',
            'stickies',
            'calendar',
            'contacts',
            'chat',
        ]);
    });

    test('cycles through the apps every two seconds in the order of the pitch line', async () => {
        const hero = await renderHero();
        for (const id of [...ORDER, ORDER[0]]) {
            await tick(2000);
            expect(headline(hero)).toBe(`your own${id}`);
        }
    });

    test('shows the app under the pointer and holds the cycle until it leaves', async () => {
        const hero = await renderHero();
        const drawings = hero.querySelectorAll('p a')[5];
        if (!drawings) throw new Error('no drawings link');
        await act(async () => void drawings.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
        expect(headline(hero)).toBe('your ownvector');
        await tick(6000);
        expect(headline(hero)).toBe('your ownvector');
        await act(async () => void drawings.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
        await tick(2000);
        expect(headline(hero)).toBe('your ownstickies');
    });

    test('does not cycle under reduced motion', async () => {
        const realMatchMedia = happyDom.matchMedia.bind(happyDom);
        happyDom.matchMedia = (query) => {
            const list = realMatchMedia(query);
            Object.defineProperty(list, 'matches', { value: query.includes('prefers-reduced-motion') });
            return list;
        };
        const hero = await renderHero();
        await tick(6000);
        expect(headline(hero)).toBe('your ownworkspace');
        happyDom.matchMedia = realMatchMedia;
    });

    test('says only the demo copy, with no app links, on a demo server', async () => {
        const hero = await renderHero(true);
        expect(hero.textContent).toContain('Tuimel Festival');
        expect(hero.querySelectorAll('a')).toHaveLength(0);
    });
});
