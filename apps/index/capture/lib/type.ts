// Types text into a capture scene one key at a time with an uneven rhythm, so a filmed persona looks like a person
// typing rather than a paste.

import type { Page } from 'playwright-core';

export async function typeLikeAPerson(page: Page, text: string): Promise<void> {
    for (const char of text) {
        await page.keyboard.type(char);
        await Bun.sleep(50 + Math.random() * 70);
    }
}
