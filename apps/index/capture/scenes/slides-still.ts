// The Slides page's still: the sponsor deck in dark, on the slide of what a sponsor gets, its heading selected so the
// properties panel shows its hand-drawn font.

import { elementPoint } from '../lib/canvas';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openSponsorDeck, thumbnailPoint } from './sponsor-deck';

export const slidesStillHeading = {
    name: 'slides-still-heading',
    kind: 'still',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['slides'],
    personas: ['mees'],
    run: async ({ pages: [page], stack }) => {
        await openSponsorDeck(page, stack);
        const thumbnail = await thumbnailPoint(page, 'what-you-get');
        await page.mouse.click(thumbnail.x, thumbnail.y);
        await Bun.sleep(1000);
        const heading = await elementPoint(page, 'el-what-you-get-text-0');
        await page.mouse.click(heading.x, heading.y);
        await Bun.sleep(1500);
    },
} satisfies Scene;
