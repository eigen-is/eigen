import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CreateContactInput } from '@workspace/lib/types/contact';
import type { SSEvent } from '@workspace/lib/types/sse';
import { Contacts } from '../lib/contacts/contacts';
import type * as contactsSchema from '../lib/contacts/schema';
import { type DatabaseConfig, ManagedDatabase, type SchemaType } from '../lib/core';
import type { Home } from '../lib/home';

// One scratch root per test run; makeContacts hands each harness its own home-N subdir and mkdirs it, so no
// shared beforeAll hook is needed (an imported module's top-level hooks wouldn't fire per importing test file).
export const CONTACTS_TEST_ROOT = join(import.meta.dir, `../../../../data-test/test-contacts-${Date.now()}`);
let counter = 0;

// Isolated Contacts instance over a temp home dir (mount.test.ts's pattern): a stub Home supplies only the
// members Contacts touches — a memoized getLocalDatabase (so a second init() reuses the same connection), the
// current user, and a broadcast sink.
export async function makeContacts() {
    const dir = join(CONTACTS_TEST_ROOT, `home-${counter++}`);
    mkdirSync(dir, { recursive: true });
    const broadcasts: SSEvent[] = [];
    const user = { id: randomUUID(), email: `me-${counter}@test.local`, name: 'Ada Lovelace' };
    const dbCache = new Map<string, Promise<ManagedDatabase<SchemaType>>>();
    const getLocalDatabase = ((config: DatabaseConfig<SchemaType>, relativePath: string) => {
        let entry = dbCache.get(relativePath);
        if (!entry) {
            entry = (async () => {
                const mdb = new ManagedDatabase(config, join(dir, relativePath));
                await mdb.open(0);
                return mdb;
            })();
            dbCache.set(relativePath, entry);
        }
        return entry;
    }) as Home['getLocalDatabase'];
    const home = {
        homeDir: dir,
        user,
        getLocalDatabase,
        broadcast: (e: SSEvent) => broadcasts.push(e),
    } as unknown as Home;
    const contacts = new Contacts(home);
    await contacts.init();
    const managed = (await dbCache.get('eigen.contacts/contacts.db')!) as ManagedDatabase<typeof contactsSchema>;
    return { contacts, broadcasts, user, dir, db: managed.db };
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
