// The Sheets page's opening loop: the finance lead runs an eye down the budget, turns the ticket line into a formula
// of tickets times price, watches the totals and the margin follow, and undoes it, so the loop ends where it began.

import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { cellPoint, openBudget } from './budget';

export const sheetsHero = {
    name: 'sheets-hero',
    kind: 'video',
    theme: 'dark',
    viewport: { width: 1600, height: 900 },
    apps: ['sheets'],
    personas: ['bram'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openBudget(page, stack);
        await cursor.moveTo({ x: 800, y: 450 }, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(800);
        await cursor.moveTo(await cellPoint(page, 'A4'));
        await cursor.moveTo(await cellPoint(page, 'B16'), { duration: 1600 });
        await Bun.sleep(500);
        await cursor.click(await cellPoint(page, 'B4'));
        await Bun.sleep(600);
        await typeLikeAPerson(page, '=1600*30');
        await Bun.sleep(500);
        await page.keyboard.press('Enter');
        await Bun.sleep(400);
        await cursor.moveTo(await cellPoint(page, 'B8'), { duration: 700 });
        await Bun.sleep(900);
        await cursor.moveTo(await cellPoint(page, 'B18'), { duration: 700 });
        await Bun.sleep(2000);
        await page.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        await cursor.moveTo({ x: 800, y: 450 }, { duration: 1200 });
        await Bun.sleep(600);
    },
} satisfies Scene;
