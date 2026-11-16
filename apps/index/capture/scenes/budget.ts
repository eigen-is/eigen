// The seeded budget as the Sheets scenes film it: opened ready to film, the screen point of a cell on its first tab,
// worked out from the column widths the seeder gives the tab, a point on the costs chart beside the table, and the
// quiet edit and undo a scene makes before the camera rolls.

import type { Page } from 'playwright-core';
import {
    SHEET_COLUMN_HEADER_HEIGHT,
    SHEET_DEFAULT_ROW_HEIGHT,
    SHEET_ROW_HEADER_WIDTH,
} from '../../../../packages/lib/src/sheets';
import { DRIVE_TYPE_SHEETS } from '../../../../packages/lib/src/types/drive';
import { BUDGET } from '../../../api/src/scripts/demo/content';
import type { Cursor, Point } from '../lib/cursor';
import { pointOn } from '../lib/cursor';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

const COLUMN_WIDTHS = BUDGET.sheets[0].columns.map((column) => column.width);

export async function openBudget(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_TYPE_SHEETS, BUDGET.name);
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
        x: grid.x + SHEET_ROW_HEADER_WIDTH + left + COLUMN_WIDTHS[column] / 2,
        y: grid.y + SHEET_COLUMN_HEADER_HEIGHT + (row + 0.5) * SHEET_DEFAULT_ROW_HEIGHT,
    };
}

export async function chartPoint(page: Page, across: number, down: number): Promise<Point> {
    return pointOn(page.locator('[data-floating-id="chart-1"]'), across, down);
}

// A take that ends with an undo ends with the selection one step on from the edited cell and an empty formula bar, as
// the bar is not filled again after an undo. A scene makes the same edit and undo here before the camera rolls, with
// the key that ends its own edit, so its film starts as it ends.
export async function editAndUndo(page: Page, cursor: Cursor, ref: string, key: 'Enter' | 'Tab'): Promise<void> {
    await cursor.click(await cellPoint(page, ref));
    await page.keyboard.type('1');
    await page.keyboard.press(key);
    await page.keyboard.press('ControlOrMeta+z');
    await Bun.sleep(500);
}
