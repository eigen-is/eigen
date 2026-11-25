// Team settings saves its name, calendar access and settings through one save. An empty name is refused under the
// field and nothing is written, and a name put back to the saved one is left out of the save.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { OrgTeam } from '@workspace/lib/types/admin';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const TEAM: OrgTeam = { id: 't'.repeat(32), name: 'Design', createdAt: new Date() };
const mutation = { mutate: () => {}, isPending: false };
const save = mock((_parts: object) => {});
afterEach(() => save.mockClear());

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realTeam = { ...(await import('@workspace/lib/team')) };
mock.module('@workspace/lib/team', () => ({
    ...realTeam,
    useTeamSettings: () => ({ data: { calendar: { enabled: false } } }),
    useSaveTeamSettings: () => ({ ...mutation, mutate: save }),
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

const { act, createElement } = await import('react');
const { TeamSettingsSection } = await import('../../../components/admin/team-settings-section');

const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
};
const nameField = () => {
    const tag = [...document.querySelectorAll('label')].find((l) => l.textContent === 'Team name');
    const input = tag && document.getElementById(tag.htmlFor);
    if (!(input instanceof HTMLInputElement)) throw new Error('no Team name field');
    return input;
};
const typeName = (value: string) =>
    act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(nameField(), value);
        nameField().dispatchEvent(new Event('input', { bubbles: true }));
    });

async function openForm() {
    await renderInDocument(createElement(TeamSettingsSection, { team: TEAM, organizationId: 'org-1' }));
    await act(async () => button('Edit').click());
}

test('an empty name is refused under the field and nothing is written', async () => {
    await openForm();
    await typeName('  ');
    await act(async () => button('Save settings').click());
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Add a name');
    expect(nameField().getAttribute('aria-invalid')).toBe('true');
});

test('a new name is saved trimmed with the settings, and the saved name is left out', async () => {
    await openForm();
    await act(async () => button('Save settings').click());
    await typeName(' Studio ');
    await act(async () => button('Save settings').click());
    expect(save.mock.calls.map(([parts]) => parts)).toEqual([
        {
            name: undefined,
            calendar: undefined,
            settings: {
                calendar: { enabled: false },
                notifyMembers: true,
                memberOverrides: { homeDataMaxMB: undefined, defaultMountMaxSizeMB: undefined },
            },
        },
        {
            name: 'Studio',
            calendar: undefined,
            settings: {
                calendar: { enabled: false },
                notifyMembers: true,
                memberOverrides: { homeDataMaxMB: undefined, defaultMountMaxSizeMB: undefined },
            },
        },
    ]);
});
