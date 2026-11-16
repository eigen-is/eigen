// Two people in the budget at once: the director selects the security line on her own screen, and her selection and
// then her new number arrive live in the finance lead's. She undoes it at the end, so the loop ends where it began.
// The film shows both screens side by side.

import type { Scene } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { cellPoint, editAndUndo, openBudget } from './budget';

export const sheetsCollabPair = {
    name: 'sheets-collab-pair',
    kind: 'video',
    theme: 'light',
    // Wide enough for the table and the costs chart beside it, whole.
    viewport: { width: 990, height: 800 },
    composite: 'side-by-side',
    apps: ['sheets'],
    personas: ['bram', 'anouk'],
    setup: async ({ pages: [bram, anouk], cursors: [bramCursor, anoukCursor], stack }) => {
        await Promise.all([bram, anouk].map((page) => openBudget(page, stack)));
        // Her name tag then sits on the status beside her number on his screen too, as it does at the end.
        await editAndUndo(anouk, anoukCursor, 'B13', 'Tab');
        await bramCursor.moveTo(await cellPoint(bram, 'A16'), { duration: 1 });
        await Bun.sleep(1500);
    },
    run: async ({ pages: [bram, anouk], cursors: [bramCursor, anoukCursor] }) => {
        await Bun.sleep(800);
        await bramCursor.moveTo(await cellPoint(bram, 'C17'), { duration: 900 });
        await Bun.sleep(700);
        await anoukCursor.click(await cellPoint(anouk, 'B13'));
        await Bun.sleep(1800);
        await typeLikeAPerson(anouk, '7500');
        // Tab, not Enter, so her name tag sits beside the new number rather than over it.
        await anouk.keyboard.press('Tab');
        await Bun.sleep(1200);
        await bramCursor.moveTo(await cellPoint(bram, 'C18'), { duration: 800 });
        await Bun.sleep(2500);
        await anouk.keyboard.press('ControlOrMeta+z');
        await Bun.sleep(1500);
        await bramCursor.moveTo(await cellPoint(bram, 'A16'), { duration: 1000 });
        await Bun.sleep(800);
    },
} satisfies Scene;
