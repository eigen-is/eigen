// The sponsor deck presented: the comms lead presses Present, the title fills the screen, the arrow keys step through
// the pitch to this year's sponsors, and Escape brings the editor back, where a click on the first slide ends the loop
// where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openSponsorDeck, slideIndex, thumbnailPoint } from './sponsor-deck';

export const slidesPresent = {
    name: 'slides-present',
    kind: 'video',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['slides'],
    personas: ['mees'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSponsorDeck(page, stack);
        await cursor.moveTo({ x: 630, y: 350 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const present = await pointOn(page.getByRole('button', { name: 'Present' }));
        await Bun.sleep(800);
        await cursor.click(present);
        // The pointer would rest on every slide's heading, so it moves to the corner the slides leave empty.
        await cursor.moveTo({ x: VIEWPORT.width - 60, y: VIEWPORT.height - 40 }, { duration: 700 });
        await Bun.sleep(1800);
        for (let slide = 1; slide <= slideIndex('sponsors'); slide++) {
            await page.keyboard.press('ArrowRight');
            await Bun.sleep(2000);
        }
        await page.keyboard.press('Escape');
        await Bun.sleep(1200);
        await cursor.click(await thumbnailPoint(page, 'title'));
        await Bun.sleep(800);
        await cursor.moveTo({ x: 630, y: 350 }, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
