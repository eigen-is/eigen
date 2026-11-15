// The two stills of the Calendar page: the festival week as the production lead sees it, with the build day, the
// go/no-go and the festival weekend, in light; and the build day opened on its guests, in dark.

import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openFestivalWeek } from './festival-week';

const still: Pick<Scene, 'kind' | 'viewport' | 'apps' | 'personas'> = {
    kind: 'still',
    viewport: VIEWPORT,
    apps: ['calendar'],
    personas: ['saar'],
};

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
        await page.goto(stack.appUrl('calendar'));
        await page.getByText('Build day').first().click();
        await page.getByRole('dialog').getByText('Fencing, stages, power.').waitFor();
        await Bun.sleep(1500);
    },
} satisfies Scene;
