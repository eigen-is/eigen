// The seeded site plan as the Vector scenes film it: opened, and waited on until its hand-drawn font and photo show,
// so a film starts on a ready screen.

import type { Page } from 'playwright-core';
import { DRIVE_TYPE_VECTOR } from '../../../../packages/lib/src/types/drive';
import { SITE_PLAN } from '../../../api/src/scripts/demo/content';
import { openFile } from '../lib/open';
import type { Stack } from '../lib/scene';

export async function openSitePlan(page: Page, stack: Stack): Promise<void> {
    await openFile(page, stack, DRIVE_TYPE_VECTOR, SITE_PLAN.name);
    await page.locator('[data-element-id="el-main-stage"]').first().waitFor();
    // The hand-drawn font and the camping photo land after the first paint.
    await Bun.sleep(4000);
}
