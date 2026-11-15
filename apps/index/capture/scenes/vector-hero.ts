// The Vector page's opening loop: the production lead drags the main stage across the site plan, and the power line
// from its generator and the crowd flow from the gate follow it. She undoes the move, so the loop ends where it began.

import { elementPoint } from '../lib/canvas';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openSitePlan } from './site-plan';

export const vectorHero = {
    name: 'vector-hero',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['vector'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSitePlan(page, stack);
        await cursor.moveTo({ x: 490, y: 455 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        const grip = await elementPoint(page, 'el-main-stage', 0.3, 0.75);
        await cursor.moveTo(grip);
        await Bun.sleep(300);
        await page.mouse.down();
        await cursor.moveTo({ x: grip.x - 40, y: grip.y + 70 }, { duration: 1600 });
        await page.mouse.up();
        await Bun.sleep(2500);
        await page.keyboard.press('ControlOrMeta+z');
        await page.keyboard.press('Escape');
        await Bun.sleep(1500);
        await cursor.moveTo({ x: 490, y: 455 }, { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
