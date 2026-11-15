// The seeded festival week as the Calendar stills film it: the calendar opened on the week view and stepped forward
// until the festival weekend shows, since the seeder dates it a few weeks after the day the demo is seeded.

import type { Page } from 'playwright-core';
import type { Stack } from '../lib/scene';

export async function openFestivalWeek(page: Page, stack: Stack): Promise<void> {
    await page.goto(stack.appUrl('calendar'));
    await page.getByText('View week').dispatchEvent('click');
    const festival = page.getByText('Tuimel Festival weekend').first();
    for (let week = 0; week < 8 && !(await festival.isVisible()); week++) {
        await page.locator('button:has(.lucide-chevron-right)').dispatchEvent('click');
        await Bun.sleep(800);
    }
}
