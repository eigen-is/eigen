// The seeded budget as the Sheets scenes film it: opened ready to film, and the screen point of a cell on its first
// tab, worked out from the column widths the seeder gives the tab.

import type { Page } from 'playwright-core';
import { SHEET_DEFAULT_ROW_HEIGHT } from '../../../../packages/lib/src/sheets';
import { DRIVE_MIME_SHEETS } from '../../../../packages/lib/src/types/drive';
import { BUDGET } from '../../../api/src/scripts/demo/content';
import type { Point } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

// The grid's row headers are this wide and its column headers this tall, in CSS pixels.
const ROW_HEADER_WIDTH = 46;
const COLUMN_HEADER_HEIGHT = 20;
const COLUMN_WIDTHS = BUDGET.sheets[0].columns.map((column) => column.width);

export async function openBudget(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_MIME_SHEETS, BUDGET.name);
    await page.locator('canvas').first().waitFor();
    // The canvas mounts before the workbook's first paint.
    await Bun.sleep(4000);
}

// The middle of a cell such as B5, in one of the tab's own columns. The seeder leaves every row at the default height.
export async function cellPoint(page: Page, ref: string): Promise<Point> {
    const column = ref.charCodeAt(0) - 'A'.charCodeAt(0);
    const row = Number(ref.slice(1)) - 1;
    const grid = await page.locator('canvas').first().boundingBox();
    if (!grid) throw new Error('The budget is not on the page');
    const left = COLUMN_WIDTHS.slice(0, column).reduce((sum, width) => sum + width, 0);
    return {
        x: grid.x + ROW_HEADER_WIDTH + left + COLUMN_WIDTHS[column] / 2,
        y: grid.y + COLUMN_HEADER_HEIGHT + (row + 0.5) * SHEET_DEFAULT_ROW_HEIGHT,
    };
}
