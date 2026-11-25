// Create team keeps the dialog contract and creates the team from the trimmed name in the organization. A name of
// only spaces says "Add a name" under the field and creates nothing.
import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const createTeam = mock(async (_name: string) => {});
const organizations: string[] = [];
// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAdmin = { ...(await import('@workspace/lib/admin')) };
mock.module('@workspace/lib/admin', () => ({
    ...realAdmin,
    useCreateTeam: (organizationId: string) => {
        organizations.push(organizationId);
        return { mutateAsync: createTeam, isPending: false };
    },
}));
afterAll(() => {
    mock.module('@workspace/lib/admin', () => realAdmin);
});

const { act, createElement, useState } = await import('react');
const { CreateTeamDialog } = await import('../../../components/admin/create-team-dialog');

let unmount = async () => {};
afterEach(() => unmount());
beforeEach(() => {
    createTeam.mockClear();
    organizations.length = 0;
});

// The dialog under a parent that owns `open`, as the teams toolbar does.
function Toolbar() {
    const [open, setOpen] = useState(true);
    return createElement(CreateTeamDialog, { open, onOpenChange: setOpen, organizationId: 'org-1' });
}

const nameField = () => {
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Team name');
    const input = label && document.getElementById(label.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error('no field labelled Team name');
    return input;
};
// React reads the value off its own tracker, so the native setter is what a keystroke looks like.
const typeName = (name: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), name);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });
const createButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Create');

test('Create team keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Toolbar),
        submitLabel: 'Create',
        firstField: 'Team name',
        onSubmit: createTeam,
        makeChanged: () => typeName('Design'),
        makeInvalid: () => typeName('   '),
        invalidField: 'Team name',
    });
});

test('Create makes the team from the trimmed name in the organization, and the dialog closes', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await typeName('  Design  ');
    await act(async () => createButton()?.click());
    expect(organizations.at(-1)).toBe('org-1');
    expect(createTeam.mock.calls).toEqual([['Design']]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('Create with no name says "Add a name" under the field and creates nothing', async () => {
    ({ unmount } = await renderInDocument(createElement(Toolbar)));
    await act(async () => createButton()?.click());
    expect(createTeam).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="field-error"]')?.textContent).toBe('Add a name');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
});
