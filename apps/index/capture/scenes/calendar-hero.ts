// The Calendar page's opening loop: in the festival's month, the production lead opens the go/no-go meeting on the eve
// of the festival in the column beside the grid and unfolds its guest list with each answer. She closes it, hides the
// team's calendar so only her own errands and appointments are left, and shows it again, so the loop ends where it
// began. Her breakfast opens that busy day, so it always shows in the month and finds the day's other events.

import type { Page } from 'playwright-core';
import type { Point } from '../lib/cursor';
import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { moreOnDayOf, openFestivalMonth } from './festival-week';

// The first event on the eve of the festival.
const EVE_FIRST_EVENT = 'Breakfast at the bakery';

export const calendarHero = {
    name: 'calendar-hero',
    kind: 'video',
    theme: 'dark',
    viewport: VIEWPORT,
    apps: ['calendar'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openFestivalMonth(page, stack, EVE_FIRST_EVENT);
        await Bun.sleep(2000);
        await cursor.moveTo(await restPoint(page), { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        const meeting = page.getByText('Go / no-go meeting');
        // The meeting is the eve's last event, so a short month row lists it under the day's "N more".
        if ((await meeting.count()) === 0) {
            await cursor.click(await pointOn(await moreOnDayOf(page, EVE_FIRST_EVENT)));
            await Bun.sleep(1000);
        }
        await cursor.click(await pointOn(meeting.first()));
        await Bun.sleep(1500);
        const detail = page.locator('[data-slot="detail-column"]');
        await cursor.click(await pointOn(detail.getByRole('button', { name: /accepted/ })));
        await Bun.sleep(3000);
        await cursor.click(await pointOn(detail.getByRole('button', { name: 'Close' })));
        await Bun.sleep(1000);
        // A calendar's row in the sidebar starts with its tick box.
        const teamRow = page.locator('div.group', { has: page.getByText('festival crew', { exact: true }) });
        const toggle = await pointOn(teamRow.getByRole('button'));
        await cursor.click(toggle);
        await Bun.sleep(2000);
        await cursor.click(toggle);
        await Bun.sleep(1200);
        await cursor.moveTo(await restPoint(page), { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;

// The toolbar's empty stretch past the month's title, read from the page, since a sidebar row, a day cell or the mini
// month lights up under the pointer.
async function restPoint(page: Page): Promise<Point> {
    const title = await page.locator('.eigen-toolbar-title').boundingBox();
    if (!title) throw new Error("The calendar's toolbar has no title");
    return { x: title.x + title.width + 80, y: title.y + title.height / 2 };
}
