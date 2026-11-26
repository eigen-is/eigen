// The stills of the Calendar page, each as the production lead sees it, their themes alternating in the carousel, such
// as this week's appointments in light and the build day opened on its guests in dark. Each picks its view, since
// Calendar opens on the view picked last.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { moreOnDayOf, openFestivalMonth, openFestivalWeek, openView, pickView } from './festival-week';

const still: Pick<Scene, 'kind' | 'viewport' | 'apps' | 'personas'> = {
    kind: 'still',
    viewport: VIEWPORT,
    apps: ['calendar'],
    personas: ['saar'],
};

export const calendarStillToday = {
    ...still,
    name: 'calendar-still-today',
    theme: 'light',
    run: async ({ pages: [page], stack }) => {
        await openView(page, stack, 'Week');
        await page.getByText('Weekly production meeting').first().waitFor();
        // The week opens an hour before the current time, so an evening take would show the night. From a quarter past
        // eight the window holds the morning's first blocks whole and the crew's production meeting at 17:00.
        await page.getByText('08:00', { exact: true }).evaluate((label) => {
            const scroller = label.closest('.overflow-y-auto');
            if (scroller && label instanceof HTMLElement) scroller.scrollTop = label.offsetTop + 12;
        });
        await Bun.sleep(1500);
    },
} satisfies Scene;

export const calendarStillWeek = {
    ...still,
    name: 'calendar-still-week',
    theme: 'light',
    run: async ({ pages: [page], stack }) => {
        await openFestivalWeek(page, stack);
        await Bun.sleep(1500);
    },
} satisfies Scene;

export const calendarStillBuild = {
    ...still,
    name: 'calendar-still-build',
    theme: 'dark',
    run: async ({ pages: [page], stack }) => {
        // Coffee on the way opens the build day, whose own event a short month row folds into "N more".
        await openFestivalMonth(page, stack, 'Coffee on the way');
        const build = page.getByText('Build day');
        if ((await build.count()) === 0) {
            await (await moreOnDayOf(page, 'Coffee on the way')).click();
            await page.getByRole('dialog').getByText('Build day').click();
        } else {
            await build.first().click();
        }
        await page.locator('[data-slot="detail-column"]').getByText('Fencing, stages, power.').waitFor();
        await Bun.sleep(1500);
    },
} satisfies Scene;

// The schedule starts on the day the last view was on, so the still opens the festival week's Wednesday, the build day,
// on its own and switches from there: the build, the eve and the festival follow it down the list.
export const calendarStillSchedule = {
    ...still,
    name: 'calendar-still-schedule',
    theme: 'dark',
    run: async ({ pages: [page], stack }) => {
        await openFestivalWeek(page, stack);
        // The week's column headers link to their days, Monday first.
        await page.locator('a[href*="/view/day/"]').nth(2).click();
        await pickView(page, 'Schedule');
        await page.getByText('Build day').first().waitFor();
        // Off the list, so no row shows the pointer's hover.
        await page.mouse.move(VIEWPORT.width / 2, 10);
        await Bun.sleep(1500);
    },
} satisfies Scene;

export const calendarStillMonth = {
    ...still,
    name: 'calendar-still-month',
    theme: 'light',
    run: async ({ pages: [page], stack }) => {
        await openFestivalMonth(page, stack, 'Tuimel Festival weekend');
        await Bun.sleep(1500);
    },
} satisfies Scene;
