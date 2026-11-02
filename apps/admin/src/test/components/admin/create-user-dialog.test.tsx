// Create user turns the username into an address on the server's mail domain: lowercase, and anything an
// admin pastes after an @ dropped. A username the rules refuse is named and nothing is created. A create the server
// refuses keeps the dialog open beside the hook's toast, with no unhandled rejection. Create waits for every field
// and a password of the minimum length.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { MIN_PASSWORD_LENGTH } from '@workspace/lib/validation';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

type CreateUserInput = { name: string; email: string; password: string; role: 'admin' | 'member' };
const createUser = { mutateAsync: mock(async (_input: CreateUserInput) => {}), isPending: false };
const config = { data: { orgId: 'org-1', mailDomain: 'example.org' } };
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/admin', () => ({ ...realAdmin, useCreateUser: () => createUser }));
mock.module('@workspace/lib/public', () => ({ ...realPublic, usePublicConfig: () => config }));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
    mock.module('@workspace/lib/public', () => realPublic);
});

// A rejected create the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement } = await import('react');
const { CreateUserDialog } = await import('../../../components/admin/create-user-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    createUser.mutateAsync.mockReset();
    createUser.mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
    unhandled.length = 0;
});

async function fillAndSubmit(fields: { name: string; username: string; password: string }) {
    ({ unmount } = await renderInDocument(createElement(CreateUserDialog, { open: true, onOpenChange })));
    for (const [id, value] of Object.entries(fields)) {
        const input = document.getElementById(id);
        if (!(input instanceof HTMLInputElement)) throw new Error(`the dialog has no ${id} field`);
        await act(async () => {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
    await act(async () => {
        document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
}

test("the username becomes a lowercase address on the server's domain, and the dialog closes", async () => {
    await fillAndSubmit({ name: 'Ada Lovelace', username: 'Ada.Lovelace@gmail.com', password: 'correct horse' });
    expect(createUser.mutateAsync.mock.calls).toEqual([
        [{ name: 'Ada Lovelace', email: 'ada.lovelace@example.org', password: 'correct horse', role: 'member' }],
    ]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
});

test('a username the rules refuse is named, and nothing is created', async () => {
    await fillAndSubmit({ name: 'Ada', username: 'a', password: 'correct horse' });
    expect(document.body.textContent).toContain('Username must be 2-30 characters');
    expect(createUser.mutateAsync).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
});

test('Create waits for a password of the minimum length', async () => {
    await fillAndSubmit({ name: 'Ada', username: 'ada', password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) });
    const create = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (b) => b.textContent === 'Create',
    );
    expect(create?.disabled).toBe(true);
    expect(createUser.mutateAsync).not.toHaveBeenCalled();
});

test('a create the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    createUser.mutateAsync.mockImplementation(async () => {
        throw new Error('User already exists');
    });
    await fillAndSubmit({ name: 'Ada Lovelace', username: 'ada', password: 'correct horse' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createUser.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(unhandled).toEqual([]);
});
