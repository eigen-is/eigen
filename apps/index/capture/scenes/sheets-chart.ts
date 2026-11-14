// A chart that follows its numbers: the finance lead raises the stage and tech line in the budget, and the costs
// chart under the table grows that bar as the number lands. He undoes it, so the loop ends where it began.

import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { cellPoint, openBudget } from './budget';

export const sheetsChart = {
    name: 'sheets-chart',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 1000 },
    apps: ['sheets'],
    personas: ['bram'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openBudget(page, stack);
        await cursor.moveTo(await cellPoint(page, 'C9'), { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        await cursor.click(await cellPoint(page, 'B12'));
        await Bun.sleep(600);
        await typeLikeAPerson(page, '21000');
        await page.keyboard.press('Enter');
        await Bun.sleep(600);
        // Over the chart, beside the stage and tech bar, where the eye goes.
        const bar = await cellPoint(page, 'B30');
        await cursor.moveTo({ x: bar.x + 15, y: bar.y }, { duration: 900 });
        await Bun.sleep(2500);
        await page.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(2000);
        await cursor.moveTo(await cellPoint(page, 'C9'), { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
