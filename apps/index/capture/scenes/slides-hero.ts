// The Slides page's opening loop: the comms lead pages down the sponsor deck to who comes, adds to its line on the
// slide, reads it, and undoes it before going back to the title, so the loop ends where it began.

import { elementPoint } from '../lib/canvas';
import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { openSponsorDeck, thumbnailPoint } from './sponsor-deck';

export const slidesHero = {
    name: 'slides-hero',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['slides'],
    personas: ['mees'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSponsorDeck(page, stack);
        await cursor.moveTo({ x: 900, y: 500 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        await cursor.click(await thumbnailPoint(page, 1));
        await Bun.sleep(1200);
        const body = await elementPoint(page, 'el-who-comes-text-1');
        await cursor.moveTo(body);
        await page.mouse.dblclick(body.x, body.y);
        await Bun.sleep(400);
        await page.keyboard.press('ControlOrMeta+ArrowDown');
        await page.keyboard.press('End');
        await Bun.sleep(500);
        await typeLikeAPerson(page, ', five minutes from the sea');
        await Bun.sleep(1500);
        await page.keyboard.press('Escape');
        await Bun.sleep(1200);
        await page.keyboard.press('ControlOrMeta+z');
        // Changing slides keeps the selection, so the text box is let go first.
        await page.keyboard.press('Escape');
        await Bun.sleep(1200);
        await cursor.click(await thumbnailPoint(page, 0));
        await Bun.sleep(1000);
        await cursor.moveTo({ x: 900, y: 500 }, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
