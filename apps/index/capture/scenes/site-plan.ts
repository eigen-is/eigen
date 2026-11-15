// The seeded site plan as the Vector scenes film it: opened, and waited on until its hand-drawn font and photo show,
// so a film starts on a ready screen; and zoomed out until its fenced festival ground fits the window, for a scene
// that shows the whole plan.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_VECTOR } from '../../../../packages/lib/src/types/drive';
import { SITE_PLAN } from '../../../api/src/scripts/demo/content';
import { elementPoint } from '../lib/canvas';
import type { Cursor } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

// The room left between the fence and the canvas's edges.
const MARGIN = 16;

export async function openSitePlan(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_TYPE_VECTOR, SITE_PLAN.name);
    await page.locator('[data-element-id="el-main-stage"]').first().waitFor();
    // The hand-drawn font and the camping photo land after the first paint.
    await Bun.sleep(4000);
}

// The plan opens at 100%, wider than a 1120 window, and the infinite canvas has no zoom to fit, so this does what a
// person does: pans the fence to the middle of the canvas and Ctrl-wheels out, which zooms about the pointer.
export async function showGround(page: Page, cursor: Cursor): Promise<void> {
    const canvas = await page
        .locator('[data-element-id="el-fence"]')
        .first()
        .evaluate((fence) => {
            const container = fence.closest('[tabindex="-1"]');
            if (!container) throw new Error('The fence is not on a canvas');
            const { x, y, width, height } = container.getBoundingClientRect();
            return { x, y, width, height };
        });
    const middle = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
    await cursor.moveTo(middle, { duration: 1 });
    const fence = await elementPoint(page, 'el-fence');
    await page.mouse.wheel(fence.x - middle.x, fence.y - middle.y);
    await Bun.sleep(300);
    const fits = async () => {
        const topLeft = await elementPoint(page, 'el-fence', 0, 0);
        const bottomRight = await elementPoint(page, 'el-fence', 1, 1);
        return (
            bottomRight.x - topLeft.x <= canvas.width - 2 * MARGIN &&
            bottomRight.y - topLeft.y <= canvas.height - 2 * MARGIN
        );
    };
    await page.keyboard.down('Control');
    // A bound well past the steps to the canvas's smallest zoom, so a plan that never fits fails instead of hanging.
    for (let step = 0; !(await fits()); step++) {
        if (step === 60) throw new Error('The site plan still overflows the canvas at its smallest zoom');
        await page.mouse.wheel(0, 5);
        await Bun.sleep(200);
    }
    await page.keyboard.up('Control');
    await Bun.sleep(500);
}
