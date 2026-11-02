// Create team creates a team from the trimmed name and closes. Create waits for a name, Enter submits, and a create
// the server refuses keeps the dialog open beside the hook's toast, with no unhandled rejection.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { pressEnter } from '@workspace/ui/test/press-enter';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const createTeam = { mutateAsync: mock(async (_name: string) => {}), isPending: false };
const organizations: (string | undefined)[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useCreateTeam: (organizationId?: string) => {
        organizations.push(organizationId);
        return createTeam;
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

// A rejected create the dialog leaves unhandled would surface here, after the toast the hook already showed.
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);
afterAll(() => {
    process.off('unhandledRejection', onUnhandled);
});

const { act, createElement } = await import('react');
const { onMutationError } = await import('@workspace/lib/api-error');

// A mutation hook toasts its failure before the dialog sees it, and the dialog drops only a toasted error.
const toasted = (message: string) => {
    const failure = new Error(message);
    onMutationError(failure);
    return failure;
};
const { CreateTeamDialog } = await import('../../../components/admin/create-team-dialog');

const onOpenChange = mock((_open: boolean) => {});
let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    createTeam.mutateAsync.mockReset();
    createTeam.mutateAsync.mockImplementation(async () => {});
    onOpenChange.mockClear();
    organizations.length = 0;
    unhandled.length = 0;
});

const nameField = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[placeholder="Team name"]');
const createButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent === 'Create');

async function openAndType(name: string) {
    ({ unmount } = await renderInDocument(
        createElement(CreateTeamDialog, { open: true, onOpenChange, organizationId: 'org-1' }),
    ));
    const input = nameField();
    if (!input) throw new Error('the dialog has no name field');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, name);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    return input;
}

test('Create makes the team from the trimmed name in the organization, and the dialog closes', async () => {
    await openAndType('  Design  ');
    await act(async () => createButton()?.click());
    expect(organizations.at(-1)).toBe('org-1');
    expect(createTeam.mutateAsync.mock.calls).toEqual([['Design']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Enter in the name submits', async () => {
    const input = await openAndType('Design');
    await act(async () => pressEnter(input));
    expect(createTeam.mutateAsync.mock.calls).toEqual([['Design']]);
    expect(onOpenChange.mock.calls).toEqual([[false]]);
});

test('Create waits for a name with more than spaces', async () => {
    await openAndType('   ');
    expect(createButton()?.disabled).toBe(true);
    await act(async () => pressEnter(nameField() ?? document.body));
    expect(createTeam.mutateAsync).not.toHaveBeenCalled();
});

test('a create the server refuses keeps the dialog open, with no unhandled rejection', async () => {
    createTeam.mutateAsync.mockImplementation(async () => {
        throw toasted('Team name taken');
    });
    await openAndType('Design');
    await act(async () => createButton()?.click());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(createTeam.mutateAsync).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(createButton()?.disabled).toBe(false);
    expect(unhandled).toEqual([]);
});
