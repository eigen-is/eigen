import { join } from 'node:path';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import { Contacts } from '../lib/contacts/contacts';
import type * as contactsSchema from '../lib/contacts/schema';
import { PATHS } from '../lib/core';
import { makeTestHome } from './home-test-helpers';

// One scratch root per test run, wiped by each test file's beforeAll.
export const CONTACTS_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-contacts-${Date.now()}`);

// Isolated Contacts instance over a temp home dir — see home-test-helpers.ts for the stub Home under it.
export async function makeContacts() {
    const harness = await makeTestHome((home) => new Contacts(home), CONTACTS_TEST_ROOT);
    const managed = await harness.database<typeof contactsSchema>(PATHS.CONTACTS.DB);
    return {
        contacts: harness.instance,
        broadcasts: harness.broadcasts,
        user: harness.user,
        dir: harness.dir,
        db: managed.db,
        close: harness.close,
    };
}

// The avatar cache is the one thing contacts still keeps as files, so tests still reach for its directory.
export const avatarsDirOf = (dir: string) => join(dir, 'eigen.contacts', 'avatars');

// The stored bytes of a card, which are the truth every card assertion reads.
export async function cardTextOf(contacts: Contacts, uri: string): Promise<string> {
    const card = await contacts.getCard(uri);
    if (!card) throw new Error(`no card stored at ${uri}`);
    return new TextDecoder().decode(card.bytes);
}

export const validContact = (over: Partial<CreateContactInput>): CreateContactInput => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: ['ada@example.com'],
    phone: [],
    ...over,
});

// A real image through the staging endpoint, exactly as the REST avatar upload does: uploadAvatar transcodes
// it to a webp and returns the `contacts/{userId}/avatar/{uuid}.webp` staged URL.
export async function stageAvatar(contacts: Contacts): Promise<string> {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 120, b: 200 } } })
        .png()
        .toBuffer();
    return contacts.uploadAvatar(new File([new Uint8Array(png)], 'avatar.png', { type: 'image/png' }));
}
