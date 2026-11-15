// The two stills of the Sheets page: the budget with its costs chart in light, and the income pie on its second tab
// in dark, each as it opens, with nothing open.

import type { Scene } from '../lib/scene';
import { openBudget } from './budget';

const still: Pick<Scene, 'kind' | 'viewport' | 'apps' | 'personas'> = {
    kind: 'still',
    viewport: { width: 1600, height: 900 },
    apps: ['sheets'],
    personas: ['bram'],
};

export const sheetsStillBudget = {
    ...still,
    name: 'sheets-still-budget',
    theme: 'light',
    run: async ({ pages: [page], stack }) => {
        await openBudget(page, stack);
    },
} satisfies Scene;

export const sheetsStillChart = {
    ...still,
    name: 'sheets-still-chart',
    theme: 'dark',
    run: async ({ pages: [page], stack }) => {
        await openBudget(page, stack);
        await page.locator('text="Charts"').dispatchEvent('click');
        await Bun.sleep(3000);
    },
} satisfies Scene;
