// Create contact and Edit contact keep the page contract: the first name has the focus, Enter and Cmd+Enter save once,
// a contact with no name is pointed at, Save shows that it is busy, and leaving with a change asks. A new contact's
// button says Create, an edited one's Save.
import { afterAll, mock, test } from 'bun:test';
import { emptyContact } from '@workspace/lib/constants/contact';
import type { Contact, CreateContactInput } from '@workspace/lib/types/contact';
import { expectFormContract, type } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const session = { user: { id: 'u1', email: 'me@test.eigen.is', name: 'Me' } };
const labels = { data: [] };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useLabels: () => labels }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/contacts', () => realContacts);
});

const { createElement } = await import('react');
const { UploadProvider } = await import('@workspace/ui/components/upload-provider');
const { ContactEdit } = await import('../../../components/contacts/contact-edit');

const ada: Contact = { ...emptyContact, id: 'c1', etag: 'v1', firstName: 'Ada', lastName: 'Lovelace' };
const save = mock(async (_data: CreateContactInput, _etag: string) => {});

// The avatar uploads through the provider every app mounts around its routes.
const page = (contact: Contact, isNew: boolean) => () =>
    createElement(
        UploadProvider,
        null,
        createElement(ContactEdit, { contact, isNew, onSave: save, onCancel: () => {} }),
    );

test('Create contact keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: page(emptyContact, true),
        submitLabel: 'Create',
        firstField: 'First name',
        onSubmit: save,
        makeChanged: () => type('First name', 'Fenna'),
        makeInvalid: () => type('First name', '   '),
        invalidField: 'First name',
    });
});

test('Edit contact keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: page(ada, false),
        submitLabel: 'Save',
        firstField: 'First name',
        onSubmit: save,
        makeChanged: () => type('Company', 'Analytical Engines'),
        makeInvalid: async () => {
            await type('First name', '');
            await type('Last name', '');
        },
        invalidField: 'First name',
    });
});
