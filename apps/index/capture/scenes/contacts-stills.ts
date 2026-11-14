// The two stills of the Contacts page: the farmer's card in the production lead's own address book, with her phone,
// farm and gate-code note, in dark; and the first aider's vCard that came by mail, open in the preview with its
// Import to Contacts button, in light.

import type { Scene } from '../lib/scene';

const still: Pick<Scene, 'kind' | 'viewport'> = { kind: 'still', viewport: { width: 1600, height: 900 } };

export const contactsStillCard = {
    ...still,
    name: 'contacts-still-card',
    theme: 'dark',
    apps: ['contacts'],
    personas: ['saar'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('contacts'));
        await page.getByText('Griet Tuimelaar').first().dispatchEvent('click');
        await page.getByText('Owns the field. Gate code by text.').waitFor();
        await Bun.sleep(1500);
    },
} satisfies Scene;

export const contactsStillVCard = {
    ...still,
    name: 'contacts-still-vcard',
    theme: 'light',
    apps: ['mail'],
    personas: ['nour'],
    run: async ({ pages: [page], stack }) => {
        await page.goto(stack.appUrl('mail'));
        await page.getByText('Re: Volunteers needed for build weekend').first().dispatchEvent('click');
        await page.getByText('hanna groen.vcf').first().click();
        await page.getByRole('button', { name: 'Import to Contacts' }).waitFor();
        // The drawn pointer stays where the mouse last moved, and in the corner it hangs off the screen.
        await page.mouse.move(1599, 899);
        await Bun.sleep(2000);
    },
} satisfies Scene;
