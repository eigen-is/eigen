// The Vector page's still: the site plan in light with the barn stage selected, so the properties panel shows its
// hand-drawn font and cross-hatched fill. The pointer leaves the screen before the picture.

import { elementPoint } from '../lib/canvas';
import type { Scene } from '../lib/scene';
import { openSitePlan } from './site-plan';

export const vectorStillSketch = {
    name: 'vector-still-sketch',
    kind: 'still',
    theme: 'light',
    viewport: { width: 1600, height: 900 },
    apps: ['vector'],
    personas: ['saar'],
    run: async ({ pages: [page], stack }) => {
        await openSitePlan(page, stack);
        const barn = await elementPoint(page, 'el-barn-stage', 0.5, 0.3);
        await page.mouse.click(barn.x, barn.y);
        // The drawn pointer stays where the mouse last moved, and in the corner it hangs off the screen.
        await page.mouse.move(1599, 899);
        await Bun.sleep(1500);
    },
} satisfies Scene;
