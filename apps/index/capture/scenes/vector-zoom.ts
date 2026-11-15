// The site plan on its infinite canvas: the festival director zooms out until the whole festival ground shows, from the
// dunes to the camping field, takes it in, and zooms back in on the same spot, so the loop ends where it began.

import type { Scene } from '../lib/scene';
import { openSitePlan } from './site-plan';

// Ctrl-wheel steps zoom about the pointer, so the same steps back land on the same view.
const STEPS = 18;
const DELTA = 5;

export const vectorZoom = {
    name: 'vector-zoom',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['vector'],
    personas: ['anouk'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSitePlan(page, stack);
        await cursor.moveTo({ x: 650, y: 520 }, { duration: 1 });
    },
    run: async ({ pages: [page] }) => {
        await Bun.sleep(1000);
        await page.keyboard.down('Control');
        for (let step = 0; step < STEPS; step++) {
            await page.mouse.wheel(0, DELTA);
            await Bun.sleep(30);
        }
        await page.keyboard.up('Control');
        await Bun.sleep(4500);
        await page.keyboard.down('Control');
        for (let step = 0; step < STEPS; step++) {
            await page.mouse.wheel(0, -DELTA);
            await Bun.sleep(30);
        }
        await page.keyboard.up('Control');
        await Bun.sleep(2000);
    },
} satisfies Scene;
