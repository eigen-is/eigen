// The income pie turned into a picture, filmed once in Vector and once in Slides: a crew member copies the pie from
// the budget's Charts tab, pastes it on a new drawing or a new slide of the sponsor deck, gives it the hand-drawn
// look and font, converts it to shapes, points a new box at the ticket slice with an arrow and pulls that slice out,
// the arrow following. Both films end on the finished picture.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_SLIDES, DRIVE_TYPE_VECTOR } from '../../../../packages/lib/src/types/drive';
import { SPONSOR_DECK } from '../../../api/src/scripts/demo/content';
import { elementPoint } from '../lib/canvas';
import type { Cursor, Point } from '../lib/cursor';
import { pointOn } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Scene, SceneContext } from '../lib/scene';
import { VIEWPORT } from '../lib/scene';
import { typeLikeAPerson } from '../lib/type';
import { openBudget } from './budget';
import { openSponsorDeck } from './sponsor-deck';

// The ticket slice runs clockwise from 12 o'clock over 58% of the pie, so its middle points just below 3 o'clock,
// in radians clockwise from 3 o'clock as the screen measures them.
const TICKET_MIDDLE = (0.58 / 2) * 2 * Math.PI - Math.PI / 2;

// The drawing the setup makes, so the pie lands on an empty canvas.
const DRAWING = 'income picture';

const pieScene: Pick<Scene, 'kind' | 'theme' | 'viewport'> = {
    kind: 'video',
    theme: 'light',
    viewport: VIEWPORT,
};

export const vectorPie = {
    ...pieScene,
    name: 'vector-pie',
    apps: ['sheets', 'vector'],
    personas: ['saar'],
    setup: async (ctx) => {
        const [page] = ctx.pages;
        await page.goto(ctx.stack.appUrl('vector'));
        await page.getByRole('button', { name: 'New vector' }).click();
        await page.getByLabel('Vector name').fill(DRAWING);
        await page.getByRole('button', { name: 'Create' }).click();
        await page.getByRole('button', { name: /^Rectangle/ }).waitFor();
        await openCharts(ctx);
    },
    run: async (ctx) => {
        const [page] = ctx.pages;
        await copyPie(ctx);
        await openFile(page, ctx.stack, DRIVE_TYPE_VECTOR, DRAWING);
        await page.getByRole('button', { name: /^Rectangle/ }).waitFor();
        await Bun.sleep(800);
        await drawPicture(ctx, await pasteChart(ctx));
    },
} satisfies Scene;

export const slidesPie = {
    ...pieScene,
    name: 'slides-pie',
    apps: ['sheets', 'slides'],
    personas: ['bram'],
    setup: async (ctx) => {
        await openSponsorDeck(ctx.pages[0], ctx.stack);
        await openCharts(ctx);
    },
    run: async (ctx) => {
        const [page] = ctx.pages;
        const [cursor] = ctx.cursors;
        await copyPie(ctx);
        await openFile(page, ctx.stack, DRIVE_TYPE_SLIDES, SPONSOR_DECK.name);
        await page.locator('[data-element-id="el-title-text-0"]').first().waitFor();
        await Bun.sleep(900);
        await cursor.click(await pointOn(page.getByRole('menuitem', { name: 'Insert', exact: true })));
        await Bun.sleep(400);
        await cursor.click(await pointOn(page.getByRole('menuitem', { name: 'New slide', exact: true })));
        await Bun.sleep(700);
        const before = await pasteChart(ctx);
        // A pasted chart keeps its size, which is small on a slide 1920 wide, so it is made bigger first.
        const chart = [...(await elementIds(page))].find((id) => !before.has(id)) ?? '';
        const topLeft = await elementPoint(page, chart, 0, 0);
        const bottomRight = await elementPoint(page, chart, 1, 1);
        await cursor.moveTo(topLeft);
        await page.mouse.down();
        await cursor.moveTo(
            { x: topLeft.x - 0.75 * (bottomRight.x - topLeft.x), y: topLeft.y - 0.75 * (bottomRight.y - topLeft.y) },
            { duration: 900 },
        );
        await page.mouse.up();
        await Bun.sleep(600);
        await drawPicture(ctx, before);
    },
} satisfies Scene;

// The budget on its Charts tab, with the pointer resting beside the pie.
async function openCharts({ pages: [page], cursors: [cursor], stack }: SceneContext): Promise<void> {
    await openBudget(page, stack);
    await page.locator('text="Charts"').dispatchEvent('click');
    await Bun.sleep(2000);
    await cursor.moveTo({ x: 630, y: 315 }, { duration: 1 });
}

async function copyPie({ pages: [page], cursors: [cursor] }: SceneContext): Promise<void> {
    await Bun.sleep(600);
    await cursor.click(await pointOn(page.locator('[data-floating-id="chart-2"]'), 0.62, 0.55));
    await Bun.sleep(600);
    await page.keyboard.press('ControlOrMeta+c');
    await Bun.sleep(300);
}

// Pastes the copied pie and gives the ids that were there before it.
async function pasteChart({ pages: [page] }: SceneContext): Promise<Set<string>> {
    const before = await elementIds(page);
    await page.keyboard.press('ControlOrMeta+v');
    await Bun.sleep(1000);
    return before;
}

// From the pasted chart on, which reads the same on a drawing and on a slide.
async function drawPicture(
    { pages: [page], cursors: [cursor] }: SceneContext,
    before: ReadonlySet<string>,
): Promise<void> {
    // The Sketch section sits at the foot of the chart's panel.
    await scrollPanel(page, cursor, 1);
    await cursor.click(await pointOn(page.getByRole('combobox').last()));
    await Bun.sleep(500);
    await cursor.click(await pointOn(page.getByRole('option', { name: 'Artist' })));
    await Bun.sleep(900);
    await scrollPanel(page, cursor, -1);
    await cursor.click(await pointOn(page.getByRole('button', { name: 'Inter' })));
    await Bun.sleep(500);
    await cursor.click(await pointOn(page.getByRole('menuitem', { name: 'Excalifont' })));
    await Bun.sleep(1000);
    await cursor.click(await pointOn(page.getByRole('button', { name: 'Convert to shapes' })));
    await Bun.sleep(1000);
    await page.keyboard.press('Escape');

    const pie = await pieCircle(page, before);
    const at = (radii: number, angle: number): Point => ({
        x: pie.x + Math.cos(angle) * radii * pie.r,
        y: pie.y + Math.sin(angle) * radii * pie.r,
    });

    // A box up and to the right of the pie, clear of the slice labels.
    const corner = { x: pie.x + 2.5 * pie.r, y: pie.y - 1.05 * pie.r };
    const size = { x: 1.6 * pie.r, y: 0.62 * pie.r };
    await cursor.click(await pointOn(page.getByRole('button', { name: /^Rectangle/ })));
    await Bun.sleep(300);
    await cursor.moveTo(corner);
    await page.mouse.down();
    await cursor.moveTo({ x: corner.x + size.x, y: corner.y + size.y }, { duration: 700 });
    await page.mouse.up();
    await Bun.sleep(400);
    await page.keyboard.press('Enter');
    await Bun.sleep(300);
    await typeLikeAPerson(page, 'our biggest share');
    await Bun.sleep(600);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await Bun.sleep(400);

    await cursor.click(await pointOn(page.getByRole('button', { name: /^Arrow/ })));
    await Bun.sleep(300);
    await cursor.moveTo({ x: corner.x + 4, y: corner.y + 0.7 * size.y });
    await page.mouse.down();
    await cursor.moveTo(at(0.7, -0.15), { duration: 900 });
    await page.mouse.up();
    await Bun.sleep(400);
    await page.keyboard.press('Escape');
    await Bun.sleep(700);

    // The ticket slice and its label, pulled out along the slice's middle, so the label stays beside it.
    await cursor.click(at(0.5, TICKET_MIDDLE));
    await Bun.sleep(300);
    await page.keyboard.down('Shift');
    await cursor.click(await elementPoint(page, await labelId(page, 'Ticket sales')));
    await page.keyboard.up('Shift');
    await Bun.sleep(300);
    await cursor.moveTo(at(0.5, TICKET_MIDDLE));
    await page.mouse.down();
    await cursor.moveTo(at(0.75, TICKET_MIDDLE), { duration: 900 });
    await page.mouse.up();
    await Bun.sleep(300);
    await page.keyboard.press('Escape');
    await cursor.moveTo({ x: pie.x + 1.6 * pie.r, y: pie.y + 1.5 * pie.r }, { duration: 700 });
    await Bun.sleep(1500);
}

// The id of the converted label that reads the text, on the canvas rather than in a slide's thumbnail.
async function labelId(page: Page, text: string): Promise<string> {
    const labels = await page.locator('[data-element-id]', { hasText: text }).evaluateAll((nodes) =>
        nodes.map((node) => {
            const { width, height } = node.getBoundingClientRect();
            return { id: node.getAttribute('data-element-id') ?? '', area: width * height };
        }),
    );
    const largest = labels.reduce((best, label) => (label.area > best.area ? label : best), { id: '', area: 0 });
    if (!largest.id) throw new Error(`No label reads ${text}`);
    return largest.id;
}

async function elementIds(page: Page): Promise<Set<string>> {
    const ids = await page
        .locator('[data-element-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-element-id') ?? ''));
    return new Set(ids);
}

// The circle the converted slices share: the largest of the new elements, each slice drawn in the box of its whole
// circle. A slide's thumbnail draws the same ids smaller, so the largest box of an id is the canvas's.
async function pieCircle(page: Page, before: ReadonlySet<string>): Promise<Point & { r: number }> {
    const boxes = await page.locator('[data-element-id]').evaluateAll((nodes) =>
        nodes.map((node) => {
            const { x, y, width } = node.getBoundingClientRect();
            return { id: node.getAttribute('data-element-id') ?? '', x, y, width };
        }),
    );
    const largest = boxes
        .filter((box) => !before.has(box.id))
        .reduce((best, box) => (box.width > best.width ? box : best), { id: '', x: 0, y: 0, width: 0 });
    if (!largest.width) throw new Error('The converted pie is not on the page');
    const r = largest.width / 2;
    return { x: largest.x + r, y: largest.y + r, r };
}

// Over the properties panel, 256 pixels wide at the window's right edge.
async function scrollPanel(page: Page, cursor: Cursor, direction: 1 | -1): Promise<void> {
    await cursor.moveTo({ x: VIEWPORT.width - 128, y: 420 }, { duration: 500 });
    for (let step = 0; step < 12; step++) {
        await page.mouse.wheel(0, direction * 150);
        await Bun.sleep(30);
    }
    await Bun.sleep(300);
}
