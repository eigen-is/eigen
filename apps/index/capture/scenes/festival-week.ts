// The seeded festival as the Calendar scenes open it. The seeder dates the festival three to four weeks after the day
// the demo is seeded, so the calendar opens on today and steps forward: week by week to the festival weekend, or month
// by month until an event of that week shows whole inside the window. A busy day's later events fold into its "N more",
// so a scene finds them through the day's first event. Calendar saves the view a user picks and opens on it next time,
// so every scene picks its own view rather than finding the last scene's.

import type { Locator, Page } from 'playwright-core';
import type { Stack } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';

export async function openFestivalWeek(page: Page, stack: Stack): Promise<void> {
    await openView(page, stack, 'Week');
    const festival = page.getByText('Tuimel Festival weekend').first();
    for (let week = 0; week < 8 && !(await festival.isVisible()); week++) {
        await page.getByRole('button', { name: 'Next week', exact: true }).dispatchEvent('click');
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

// The "N more" of the day an event is on: below it in its week's row, and the nearest one starting left of its text.
export async function moreOnDayOf(page: Page, title: string): Promise<Locator> {
    const event = await page.getByText(title).first().boundingBox();
    if (!event) throw new Error(`${title} is not in the month`);
    let found: { more: Locator; x: number } | null = null;
    for (const more of await page.getByRole('button', { name: /^\d+ more$/ }).all()) {
        const box = await more.boundingBox();
        const below = box && box.y > event.y && box.y - event.y < 120;
        if (below && box.x <= event.x && (!found || box.x > found.x)) found = { more, x: box.x };
    }
    if (!found) throw new Error(`The day of ${title} has no more button`);
    return found.more;
}

type View = 'Week' | 'Month' | 'Schedule';

export async function openView(page: Page, stack: Stack, view: View): Promise<void> {
    await page.goto(stack.appUrl('calendar'));
    await pickView(page, view);
}

// On a computer the view is picked in the toolbar's select; the sidebar has no view links. The new view keeps the day
// the last one was on.
export async function pickView(page: Page, view: View): Promise<void> {
    await page.getByRole('combobox').click();
    await page.getByRole('option', { name: view, exact: true }).click();
}
