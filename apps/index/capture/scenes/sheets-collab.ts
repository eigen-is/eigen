// Two people in the budget at once: the director selects the security line on her own screen, and her selection and
// then her new number arrive live in the finance lead's. She undoes it at the end, so the loop ends where it began.
// One film shows his side; the pair shows both screens side by side.

import type { Scene } from '../lib/scene';
import { cellPoint, openBudget } from './budget';

export const sheetsCollab = {
    name: 'sheets-collab',
    kind: 'video',
    theme: 'light',
    viewport: { width: 1600, height: 1000 },
    apps: ['sheets'],
    personas: ['bram', 'anouk'],
    setup: async ({ pages, stack }) => {
        await Promise.all(pages.map((page) => openBudget(page, stack)));
    },
    run: async ({ pages: [bram, anouk], cursors: [bramCursor, anoukCursor], type, hold }) => {
        await bramCursor.moveTo(await cellPoint(bram, 'A16'), { duration: 1 });
        await hold(800);
        await bramCursor.moveTo(await cellPoint(bram, 'C17'), { duration: 900 });
        await hold(700);
        await anoukCursor.click(await cellPoint(anouk, 'B13'));
        await hold(1800);
        await type(anouk, '7500');
        // Tab, not Enter, so her name tag sits beside the new number rather than over it.
        await anouk.keyboard.press('Tab');
        await hold(1200);
        await bramCursor.moveTo(await cellPoint(bram, 'C18'), { duration: 800 });
        await hold(2500);
        await anouk.keyboard.press('ControlOrMeta+z');
        await hold(1500);
        await bramCursor.moveTo(await cellPoint(bram, 'A16'), { duration: 1000 });
        await hold(800);
    },
} satisfies Scene;

export const sheetsCollabPair = {
    ...sheetsCollab,
    name: 'sheets-collab-pair',
    viewport: { width: 960, height: 800 },
    composite: 'side-by-side',
} satisfies Scene;
