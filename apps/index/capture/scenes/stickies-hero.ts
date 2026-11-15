// The Stickies page's opening loop: on the festival kanban the production lead drags the wristband print job from
// to do into doing, the way the gate lead's card says it goes to print this week. Undo puts it back, so the loop ends
// where it began.

import { DRIVE_TYPE_STICKIES } from '../../../../packages/lib/src/types/drive';
import { KANBAN } from '../../../api/src/scripts/demo/content';
import { pointOn } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

const REST = { x: 1015, y: 546 };

export const stickiesHero = {
    name: 'stickies-hero',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['stickies'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_STICKIES, KANBAN.name);
        await page.getByText('Print wristbands').waitFor();
        await Bun.sleep(2000);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        const card = await pointOn(page.getByText('Print wristbands'));
        await cursor.moveTo(card);
        await Bun.sleep(400);
        await page.mouse.down();
        // The board starts a drag only after the pointer moves a few pixels, as a hand's would.
        await cursor.moveTo({ x: card.x + 12, y: card.y + 6 }, { duration: 150 });
        const doing = await pointOn(page.getByText('Fix generator quote'));
        await cursor.moveTo({ x: doing.x, y: doing.y + 70 }, { duration: 1100 });
        await Bun.sleep(400);
        await page.mouse.up();
        await Bun.sleep(2500);
        await page.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
