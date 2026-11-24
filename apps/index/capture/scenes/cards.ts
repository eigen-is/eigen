// The pictures other sites show for Eigen: the preview card under a shared link to the public site, one card per About
// app page, and the wide header of the Open Collective page. A card puts the eigen wordmark and a line at the top in
// the middle, over stills the About overview already shows, so the square Slack cuts from its middle for a small
// preview still holds them. The header is those stills alone, since the page masks it to a curve on the right.
// Each is drawn on that overview, so the site's own fonts, colors and wordmarks are there, and an app's card takes its
// wordmark and line from the app's row.

import { basename } from 'node:path';
import { aboutRowStill, previewCard } from '../../src/content/about-media';
import type { Scene } from '../lib/scene';
import { ROWS } from './rows';

// Every app with a row on the overview, each row filmed in its own app.
const APPS = ROWS.map(({ apps: [slug] }) => slug);
// The header's stills, five across and two down with even gaps.
const MOSAIC = { columns: 5, width: 456, gap: 24, left: 12, top: 32 };
// Ten apps fill it: all but Admin, which is for the person who runs the server.
const MOSAIC_STILLS = APPS.filter((slug) => slug !== 'admin').map(aboutRowStill);

// The size link previews are made for, such as on Slack, LinkedIn and X.
const PREVIEW = { width: 1200, height: 630 };
const BANNER = { width: 2400, height: 600 };
const TAGLINE = 'A self-hosted alternative to Google Workspace.';

const cardName = (slug: string) => basename(previewCard(slug), '.jpg');

type Layout = {
    // The app whose wordmark, line and color the card takes, or none for Eigen's own.
    slug?: string;
    stills: string[];
    // Where each still stands and how wide, in the card's pixels, the last one on top.
    places: { left: number; top: number; width: number }[];
    // Whether the wordmark and the line stand over the stills.
    text: boolean;
};

const card = (name: string, viewport: Scene['viewport'], layout: Layout): Scene => ({
    name,
    kind: 'still',
    share: true,
    theme: 'light',
    viewport,
    apps: ['index'],
    personas: ['anouk'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(`${stack.appUrl('index')}/about`);
        await page.locator('a[href^="/about/"]').first().waitFor();
        await page.evaluate(drawCard, { ...layout, tagline: TAGLINE });
        await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth));
        await page.evaluate(() => document.fonts.ready);
    },
});

export const CARDS: Scene[] = [
    card(cardName('eigen'), PREVIEW, {
        stills: ['docs', 'calendar', 'sheets'].map(aboutRowStill),
        places: [
            { left: 40, top: 330, width: 560 },
            { left: 600, top: 330, width: 560 },
            { left: 250, top: 290, width: 700 },
        ],
        text: true,
    }),
    ...APPS.map((slug) =>
        card(cardName(slug), PREVIEW, {
            slug,
            stills: [aboutRowStill(slug)],
            places: [{ left: 140, top: 290, width: 920 }],
            text: true,
        }),
    ),
    card('opencollective-banner', BANNER, {
        stills: MOSAIC_STILLS,
        places: MOSAIC_STILLS.map((_, i) => ({
            left: MOSAIC.left + (i % MOSAIC.columns) * (MOSAIC.width + MOSAIC.gap),
            top: MOSAIC.top + Math.floor(i / MOSAIC.columns) * ((MOSAIC.width * 9) / 16 + MOSAIC.gap),
            width: MOSAIC.width,
        })),
        text: false,
    }),
];

// Runs in the page, so it uses nothing from outside itself: it swaps the overview for the card.
function drawCard({ slug, stills, places, text: withText, tagline }: Layout & { tagline: string }): void {
    const element = (tag: string, css: string, text?: string) => {
        const node = document.createElement(tag);
        node.style.cssText = css;
        if (text) node.textContent = text;
        return node;
    };
    const rowWordmark = slug ? document.querySelector(`a[href="/about/${slug}"] .whitespace-nowrap`) : null;
    // The row's wordmark without its own span, which sizes it for the row.
    const wordmark = rowWordmark
        ? [...rowWordmark.childNodes].map((node) => node.cloneNode(true))
        : [element('span', 'font-weight: 500', 'eigen')];
    const line = rowWordmark?.nextElementSibling?.textContent ?? tagline;
    const wash = slug ? `var(--app-${slug}-color-soft)` : 'var(--muted)';
    const card = element(
        'div',
        `position: fixed; inset: 0; overflow: hidden; font-family: var(--font-sans); color: var(--foreground);
         background: linear-gradient(180deg, var(--background) 35%, ${wash});`,
    );
    if (withText) {
        // Inside the square Slack cuts from the middle, with room to spare.
        const text = element('div', 'position: absolute; top: 44px; left: 300px; width: 600px; text-align: center;');
        const title = element('div', 'font-size: 76px; line-height: 1.1; white-space: nowrap;');
        title.append(...wordmark);
        const lineCss = 'margin-top: 14px; font-size: 36px; line-height: 1.3; color: var(--muted-foreground);';
        text.append(title, element('div', lineCss, line));
        card.append(text);
    }
    stills.forEach((src, i) => {
        const { left, top, width } = places[i];
        const image = element(
            'img',
            `position: absolute; left: ${left}px; top: ${top}px; width: ${width}px; aspect-ratio: 16 / 9;
             object-fit: cover; object-position: top; border-radius: 12px; border: 1px solid var(--border);
             box-shadow: 0 18px 50px rgb(0 0 0 / 0.18);`,
        );
        image.setAttribute('src', src);
        card.append(image);
    });
    document.body.replaceChildren(card);
}
