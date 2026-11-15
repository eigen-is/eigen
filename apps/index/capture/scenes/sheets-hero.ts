// The Sheets page's opening loop: the finance lead runs an eye down the budget, turns the security line into a formula
// of guards times hours times rate, watches its bar, the totals and the margin follow, and undoes it, so the loop ends
// where it began.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { cellPoint, chartPoint, editAndUndo, openBudget } from './budget';

// An empty cell under the table, where the resting pointer lights up nothing, as it would over the chart.
const REST = 'C20';

export const sheetsHero = {
    name: 'sheets-hero',
    kind: 'video',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['sheets'],
    personas: ['bram'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openBudget(page, stack);
        await editAndUndo(page, cursor, 'B13', 'Enter');
        await cursor.moveTo(await cellPoint(page, REST), { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        await cursor.moveTo(await cellPoint(page, 'A4'));
        await cursor.moveTo(await cellPoint(page, 'B16'), { duration: 1600 });
        await Bun.sleep(500);
        await cursor.click(await cellPoint(page, 'B13'));
        await Bun.sleep(600);
        await typeLikeAPerson(page, '=14*40*16');
        await Bun.sleep(500);
        await page.keyboard.press('Enter');
        await Bun.sleep(400);
        await cursor.moveTo(await chartPoint(page, 0.45, 0.6), { duration: 800 });
        await Bun.sleep(1200);
        await cursor.moveTo(await cellPoint(page, 'B17'), { duration: 800 });
        await Bun.sleep(900);
        await cursor.moveTo(await cellPoint(page, 'B18'), { duration: 700 });
        await Bun.sleep(2000);
        await page.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        await cursor.moveTo(await cellPoint(page, REST), { duration: 1200 });
        await Bun.sleep(600);
    },
} satisfies Scene;
