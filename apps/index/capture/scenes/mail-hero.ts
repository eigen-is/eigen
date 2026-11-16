// The Mail page's opening loop: the production lead reads the generator thread with its replies quoted, opens the
// first message, and turns its xlsx quote into a sheet in the team drive, which opens in Sheets. Back in Mail she
// returns to the last reply, so the loop ends where it began.

import { pointOn } from '../lib/cursor';
import type { Scene } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { openBudget } from './budget';

const REST = { x: 980, y: 532 };

export const mailHero = {
    name: 'mail-hero',
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
    apps: ['mail', 'sheets'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        // The dev server builds the sheet editor's modules on its first visit, which would film as seconds of white.
        const warmUp = await page.context().newPage();
        await openBudget(warmUp, stack);
        await warmUp.close();
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Re: Generator quote').first().dispatchEvent('click');
        await page.getByRole('heading', { name: 'Re: Generator quote' }).waitFor();
        // The first message's row is the list's last and partly cut off, and clicking it scrolls the list to show it
        // whole, so the film starts with it whole and ends on the same list. The virtualizer marks each row.
        await page
            .locator('[data-index]')
            .filter({ hasText: 'Hi Saar, Quote attached' })
            .evaluate((row) => row.scrollIntoView({ block: 'nearest' }));
        await Bun.sleep(1500);
        await cursor.moveTo(REST, { duration: 1 });
    },
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1200);
        await cursor.click(await pointOn(page.getByText('Hi Saar, Quote attached')));
        await Bun.sleep(1000);
        const chip = await pointOn(page.getByText('vlierkracht quote.xlsx'));
        await cursor.moveTo(chip);
        await page.mouse.click(chip.x, chip.y, { button: 'right' });
        await Bun.sleep(700);
        await cursor.click(await pointOn(page.getByRole('menuitem', { name: 'Convert to sheet' })));
        await Bun.sleep(900);
        await cursor.click(await pointOn(page.getByRole('button', { name: /festival crew/ })));
        await Bun.sleep(700);
        await cursor.click(await pointOn(page.getByRole('button', { name: 'Save and convert' })));
        await page.waitForURL(/\/sheet\//);
        await page.locator('canvas').first().waitFor();
        // The canvas mounts before the workbook's first paint, and then the quote is on screen to read.
        await Bun.sleep(3000);
        await page.goBack();
        await page.getByText('vlierkracht quote.xlsx').waitFor();
        await Bun.sleep(500);
        await cursor.click(await pointOn(page.getByText('Re: Generator quote')));
        await Bun.sleep(800);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(600);
    },
} satisfies Scene;
