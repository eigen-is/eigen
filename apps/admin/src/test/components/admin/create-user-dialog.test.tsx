// Create user keeps the dialog contract and turns the username into an address on the server's mail domain:
// lowercase, and anything an admin pastes after an @ dropped. Create with a field missing or wrong names the problem
// under each field and creates nothing, and the dialog shows no form until the server's config has loaded.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type CreateUserInput = { name: string; email: string; password: string; role: 'admin' | 'member' };
const createUser = mock(async (_input: CreateUserInput) => {});
let config: { data: { orgId: string; mailDomain: string } | undefined } = {
    data: { orgId: 'org-1', mailDomain: 'example.org' },
};
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useCreateUser: () => ({ mutateAsync: createUser, isPending: false }),
}));
mock.module('@workspace/lib/public', () => ({ ...realPublic, usePublicConfig: () => config }));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement, useState } = await import('react');
const { CreateUserDialog } = await import('../../../components/admin/create-user-dialog');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    createUser.mockClear();
    config = { data: { orgId: 'org-1', mailDomain: 'example.org' } };
});

// The dialog under a parent that owns `open`, as the users toolbar does.
function Toolbar() {
    const [open, setOpen] = useState(true);
    return createElement(CreateUserDialog, { open, onOpenChange: setOpen });
}

const field = (label: string) => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === label);
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error(`no field labelled ${label}`);
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const type = (label: string, value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field(label), value);
        field(label).dispatchEvent(new Event('input', { bubbles: true }));
    });
const fill = async (fields: { Name: string; Username: string; Password: string }) => {
    for (const [label, value] of Object.entries(fields)) await type(label, value);
};
const create = () =>
    act(async () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create')?.click());
const messageUnder = (label: string) => {
    const id = field(label).getAttribute('aria-describedby');
    return id ? document.getElementById(id)?.textContent : undefined;
};

test('Create user keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Toolbar),
        submitLabel: 'Create',
        firstField: 'Name',
        onSubmit: createUser,
        makeChanged: () => fill({ Name: 'Ada', Username: 'ada', Password: 'correct horse' }),
        makeInvalid: () => fill({ Name: '', Username: 'ada', Password: 'correct horse' }),
        invalidField: 'Name',
    });
});

test("the username becomes a lowercase address on the server's domain, and the dialog closes", async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await fill({ Name: ' Ada Lovelace ', Username: 'Ada.Lovelace@gmail.com', Password: 'correct horse' });
    await create();
    expect(createUser.mock.calls).toEqual([
        [{ name: 'Ada Lovelace', email: 'ada.lovelace@example.org', password: 'correct horse', role: 'member' }],
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Create with every field missing or wrong names each problem under its field', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await create();
    expect(messageUnder('Name')).toBe('Add a name');
    expect(messageUnder('Username')).toBe('Add a username');
    expect(messageUnder('Password')).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(document.activeElement).toBe(field('Name'));

    await fill({ Name: 'Ada', Username: 'a', Password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) });
    await create();
    expect(messageUnder('Name')).toBeUndefined();
    expect(messageUnder('Username')).toBe('Username must be 2-30 characters');
    expect(messageUnder('Password')).toBe(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    expect(createUser).not.toHaveBeenCalled();
});

test('the dialog shows no form until the config has loaded', async () => {
    config = { data: undefined };
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    expect(document.querySelector('[role="dialog"] form')).toBeNull();
});
