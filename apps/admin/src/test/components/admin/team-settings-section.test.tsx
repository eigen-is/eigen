// Team settings, opened with Edit, keeps the page contract and saves its name, calendar access and settings through
// one save, then goes back to the view. An empty name and a quota below the minimum are refused under their fields and
// nothing is written, a name put back to the saved one is left out of the save, and Cancel, or Save with nothing
// changed, goes back unsaved.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { QUOTA_MIN_MB } from '@workspace/lib/constants/settings';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { expectFormContract } from '@workspace/ui/test/form-contract';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const TEAM: OrgTeam = { id: 't'.repeat(32), name: 'Design', createdAt: new Date() };
const mutation = { mutate: () => {}, isPending: false };
const save = mock(async (_parts: object) => {});
afterEach(() => save.mockClear());

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realTeam = { ...(await import('@workspace/lib/team')) };
mock.module('@workspace/lib/team', () => ({
    ...realTeam,
    useTeamSettings: () => ({ data: { calendar: { enabled: false } } }),
    useSaveTeamSettings: () => ({ mutateAsync: save, isPending: false }),
    useUploadTeamAvatar: () => mutation,
    useRemoveTeamAvatar: () => mutation,
}));
const realCalendar = { ...(await import('@workspace/lib/calendar')) };
mock.module('@workspace/lib/calendar', () => ({ ...realCalendar, useCalendars: () => ({ data: [] }) }));
const realPublic = { ...(await import('@workspace/lib/public')) };
mock.module('@workspace/lib/public', () => ({ ...realPublic, useHomeDataLabel: () => 'Mail, Contacts & Calendar' }));
// The avatars read the address book, which this test has no server for.
const realUser = { ...(await import('@workspace/ui/components/user')) };
mock.module('@workspace/ui/components/user', () => ({ ...realUser, UserAvatar: () => null }));
const realAvatarEditor = { ...(await import('@workspace/ui/components/avatar-editor')) };
mock.module('@workspace/ui/components/avatar-editor', () => ({ AvatarEditor: () => null }));
afterAll(() => {
    mock.module('@workspace/ui/components/user', () => realUser);
    mock.module('@workspace/ui/components/avatar-editor', () => realAvatarEditor);
    mock.module('@workspace/lib/team', () => realTeam);
    mock.module('@workspace/lib/calendar', () => realCalendar);
    mock.module('@workspace/lib/public', () => realPublic);
});

const { act, createElement, useEffect } = await import('react');
const router = await import('@tanstack/react-router');
const { TeamSettingsSection } = await import('../../../components/admin/team-settings-section');

const button = (label: string) =>
    [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);

// The section with its Edit pressed as it mounts, as an admin opens it.
function EditedSection() {
    useEffect(() => button('Edit')?.click(), []);
    return createElement(TeamSettingsSection, { team: TEAM, organizationId: 'org-1' });
}

async function openForm() {
    const root = router.createRootRoute({ component: router.Outlet });
    const page = router.createRoute({ getParentRoute: () => root, path: '/', component: EditedSection });
    const memory = router.createRouter({
        routeTree: root.addChildren([page]),
        history: router.createMemoryHistory({ initialEntries: ['/'] }),
    });
    await memory.load();
    await renderInDocument(createElement(router.RouterProvider, { router: memory }));
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
const click = (label: string) => act(async () => button(label)?.click());

const SETTINGS = {
    calendar: { enabled: false },
    notifyMembers: true,
    memberOverrides: { homeDataMaxMB: undefined, defaultMountMaxSizeMB: undefined },
};

test('Team settings keeps the page contract', async () => {
    await expectFormContract({
        kind: 'page',
        render: () => createElement(EditedSection),
        submitLabel: 'Save',
        firstField: 'Team name',
        onSubmit: save,
        makeChanged: () => type('Team name', 'Studio'),
        makeInvalid: () => type('Team name', '  '),
        invalidField: 'Team name',
    });
});

test('a new name is saved trimmed with the settings, and the form goes back to the view', async () => {
    await openForm();
    await type('Team name', ' Studio ');
    await click('Save');
    expect(save.mock.calls).toEqual([[{ name: 'Studio', calendar: undefined, settings: SETTINGS }]]);
    expect(button('Edit')).toBeDefined();
});

test('a name put back to the saved one is left out of the save', async () => {
    await openForm();
    await type('Team name', 'Studio');
    await type(`Mail, Contacts & Calendar (MB)`, '500');
    await type('Team name', 'Design');
    await click('Save');
    expect(save.mock.calls).toEqual([
        [
            {
                name: undefined,
                calendar: undefined,
                settings: { ...SETTINGS, memberOverrides: { homeDataMaxMB: 500, defaultMountMaxSizeMB: undefined } },
            },
        ],
    ]);
});

test('a quota below the minimum is refused under its field, and nothing is written', async () => {
    await openForm();
    await type('Default mount (MB)', String(QUOTA_MIN_MB - 1));
    await click('Save');
    expect(save).not.toHaveBeenCalled();
    const mount = field('Default mount (MB)');
    expect(mount.getAttribute('aria-invalid')).toBe('true');
    const message = document.getElementById(mount.getAttribute('aria-describedby') ?? '');
    expect(message?.textContent).toBe(`At least ${QUOTA_MIN_MB} MB`);
    expect(document.activeElement).toBe(mount);
});

test('Cancel goes back to the view and writes nothing', async () => {
    await openForm();
    await type('Team name', 'Studio');
    await click('Cancel');
    expect(save).not.toHaveBeenCalled();
    expect(button('Edit')).toBeDefined();
});

test('Save with nothing changed goes back to the view and writes nothing', async () => {
    await openForm();
    await click('Save');
    expect(save).not.toHaveBeenCalled();
    expect(button('Edit')).toBeDefined();
});
