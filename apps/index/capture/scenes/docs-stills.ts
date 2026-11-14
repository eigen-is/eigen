// The two stills of the Docs page: the equation in the scratch doc every crew member has, selected with its panel open
// on the LaTeX, in dark; and the production plan's File menu open on Download, in light.

import { DRIVE_TYPE_DOC } from '../../../../packages/lib/src/types/drive';
import { TRYING_EIGEN } from '../../../api/src/scripts/demo/content';
import { openFile } from '../lib/open';
import type { Scene } from '../lib/scene';
import { openProductionPlan } from './production-plan';

const still: Pick<Scene, 'kind' | 'viewport' | 'apps' | 'personas'> = {
    kind: 'still',
    viewport: { width: 1600, height: 900 },
    apps: ['docs'],
    personas: ['saar'],
};

export const docsStillEquation = {
    ...still,
    name: 'docs-still-equation',
    theme: 'dark',
    run: async ({ pages: [page], stack }) => {
        await openFile(page, stack, DRIVE_TYPE_DOC, TRYING_EIGEN.name);
        await page.locator('math').first().click();
        await page.getByText('LaTeX').first().waitFor();
        // The drawn pointer stays where the mouse last moved, and in the corner it hangs off the screen.
        await page.mouse.move(1599, 899);
        await Bun.sleep(2500);
    },
} satisfies Scene;

export const docsStillDownload = {
    ...still,
    name: 'docs-still-download',
    theme: 'light',
    run: async ({ pages: [page], stack }) => {
        await openProductionPlan(page, stack);
        await page.getByRole('menuitem', { name: 'File' }).click();
        await page.getByRole('menuitem', { name: 'Download' }).hover();
        await page.getByText('Microsoft Word (.docx)').waitFor();
        await Bun.sleep(800);
    },
} satisfies Scene;
