// The Vector page's still: the site plan in light with the barn stage selected, so the properties panel shows its
// hand-drawn font and cross-hatched fill.

import { elementPoint } from '../lib/canvas';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openSitePlan, showGround } from './site-plan';

export const vectorStillSketch = {
    name: 'vector-still-sketch',
    kind: 'still',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['vector'],
    personas: ['saar'],
    run: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openSitePlan(page, stack);
        await showGround(page, cursor);
        const barn = await elementPoint(page, 'el-barn-stage', 0.5, 0.3);
        await page.mouse.click(barn.x, barn.y);
        await Bun.sleep(1500);
    },
} satisfies Scene;
