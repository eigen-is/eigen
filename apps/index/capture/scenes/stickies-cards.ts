// Two loops on the festival kanban for the Stickies page. In dark, the production lead opens the Sunday wind cover
// card and reads its thread, where her own reply carries the tent hire's contact card, then closes it. In light, she
// assigns that card to the tech lead from its menu and takes him off again. Each ends where it began.

import { DRIVE_TYPE_STICKIES } from '../../../../packages/lib/src/types/drive';
import { KANBAN } from '../../../api/src/scripts/demo/content';
import { centerOf } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Scene } from '../lib/scene';

const CARD = 'Sunday wind cover';
const REST = { x: 1450, y: 780 };

const board: Pick<Scene, 'kind' | 'viewport' | 'apps' | 'personas' | 'setup'> = {
    kind: 'video',
    viewport: { width: 1600, height: 900 },
    apps: ['stickies'],
    personas: ['saar'],
    setup: async ({ pages: [page], cursors: [cursor], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_STICKIES, KANBAN.name);
        await page.getByText(CARD).waitFor();
        await Bun.sleep(2000);
        await cursor.moveTo(REST, { duration: 1 });
    },
};

export const stickiesComment = {
    ...board,
    name: 'stickies-comment',
    theme: 'dark',
    run: async ({ pages: [page], cursors: [cursor] }) => {
        await Bun.sleep(1000);
        await cursor.click(await centerOf(page.getByText(CARD)));
        const dialog = page.getByRole('dialog');
        await dialog.getByText('dekzeil & zo.vcf').waitFor();
        await Bun.sleep(1200);
        await cursor.moveTo(await centerOf(dialog.getByText('dekzeil & zo.vcf')));
        await Bun.sleep(4000);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        await Bun.sleep(600);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;

export const stickiesAssign = {
    ...board,
    name: 'stickies-assign',
    theme: 'light',
    run: async ({ pages: [page], cursors: [cursor] }) => {
        const assign = async (who: string) => {
            const card = await centerOf(page.getByText(CARD));
            await cursor.moveTo(card);
            await page.mouse.click(card.x, card.y, { button: 'right' });
            await Bun.sleep(700);
            await cursor.click(await centerOf(page.getByRole('menuitem', { name: 'Assign to' })));
            await Bun.sleep(700);
            await cursor.click(await centerOf(page.getByRole('menuitemradio', { name: who })));
        };
        await Bun.sleep(1000);
        await assign('Timo Jansen');
        await Bun.sleep(3000);
        await assign('Unassigned');
        await Bun.sleep(1200);
        await cursor.moveTo(REST, { duration: 900 });
        await Bun.sleep(800);
    },
} satisfies Scene;
