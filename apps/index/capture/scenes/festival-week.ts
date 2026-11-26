// The seeded festival as the Calendar scenes open it. The seeder dates the festival three to four weeks after the day
// the demo is seeded, so the calendar opens on today and steps forward: week by week to the festival weekend, or month
// by month until an event of that week shows whole inside the window.

import type { Locator, Page } from 'playwright-core';
import type { Stack } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export async function openFestivalWeek(page: Page, stack: Stack): Promise<void> {
    await openView(page, stack, 'Week');
    const festival = page.getByText('Tuimel Festival weekend').first();
    for (let week = 0; week < 8 && !(await festival.isVisible()); week++) {
        await page.locator('button:has(.lucide-chevron-right)').dispatchEvent('click');
        await Bun.sleep(800);
    }
}

export async function openFestivalMonth(page: Page, stack: Stack, title: string): Promise<Locator> {
    await openView(page, stack, 'Month');
    const event = page.getByText(title).first();
    for (let month = 0; month < 3; month++) {
        // The wait gives the first month time to load its events before the calendar steps on from it.
        const box = await event.waitFor({ timeout: 5000 }).then(
            () => event.boundingBox(),
            () => null,
        );
        if (box && box.y >= 0 && box.y + box.height <= VIEWPORT.height) return event;
        // Exact, or the sidebar mini month's "Show next month" matches too.
        await page.getByRole('button', { name: 'Next month', exact: true }).dispatchEvent('click');
        await Bun.sleep(800);
    }
    throw new Error(`${title} is not in the calendar's next three months`);
}

// On a computer the view is picked in the toolbar's select; the sidebar has no view links.
async function openView(page: Page, stack: Stack, view: 'Week' | 'Month'): Promise<void> {
    await page.goto(stack.appUrl('calendar'));
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: view, exact: true }).click();
}
