// The sponsor deck presented: the comms lead presses Present, the title fills the screen, the arrow keys step through
// the pitch, and Escape brings the editor back, where a click on the first slide ends the loop where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { openSponsorDeck, thumbnailPoint } from './sponsor-deck';

export const slidesPresent = {
    name: 'slides-present',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['slides'],
    personas: ['mees'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSponsorDeck(page, stack);
        await cursor.moveTo({ x: 900, y: 500 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const present = await pointOn(page.getByRole('button', { name: 'Present' }));
        await Bun.sleep(800);
        await cursor.click(present);
        await Bun.sleep(2500);
        for (let slide = 1; slide < 4; slide++) {
            await page.keyboard.press('ArrowRight');
            await Bun.sleep(2000);
        }
        await page.keyboard.press('Escape');
        await Bun.sleep(1200);
        await cursor.click(await thumbnailPoint(page, 0));
        await Bun.sleep(800);
        await cursor.moveTo({ x: 900, y: 500 }, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
