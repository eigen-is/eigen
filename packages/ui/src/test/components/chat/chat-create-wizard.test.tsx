// The New chat wizard lists each picked person with an × that removes them, and with a team picked it shows the team
// with an × of its own. A screen reader hears each × by what it removes, never a row of bare "Remove"s, and a click
// removes only that one.
import { afterAll, expect, mock, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';
import { renderInDocument } from '../../render-in-document';

installHappyDom();

const DESIGN_TEAM = {
    id: 'team-design',
    name: 'Design',
    mounts: [{ id: 'design-drive', rootPathId: 'design-root' }],
    members: [],
};
let myTeams: (typeof DESIGN_TEAM)[] = [];

// Copies, because mock.module rewrites a loaded module's exports in place, and afterAll puts the originals back.
const realAuth = { ...(await import('@workspace/lib/auth')) };
mock.module('@workspace/lib/auth', () => ({
    ...realAuth,
    useAuth: () => ({ user: { id: 'me', name: 'Me', email: 'me@example.com' } }),
    useIsGuest: () => false,
}));
const realChat = { ...(await import('@workspace/lib/chat')) };
mock.module('@workspace/lib/chat', () => ({
    ...realChat,
    useChatSections: () => ({ teams: [], isLoading: false }),
    useCreateChatRoom: () => ({ mutateAsync: async () => {}, isPending: false }),
    useFindChatByMembers: () => ({ data: [], isPending: false }),
}));
const realHome = { ...(await import('@workspace/lib/home')) };
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: myTeams }) }));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/chat', () => realChat);
    mock.module('@workspace/lib/home', () => realHome);
});

const { act, createElement } = await import('react');
const { ChatCreateWizard } = await import('../../../components/chat/chat-create-wizard');
const { clickRow } = await import('../../menu-rows');

async function openWizard(teams: (typeof DESIGN_TEAM)[] = []) {
    myTeams = teams;
    await renderInDocument(createElement(ChatCreateWizard, { open: true, onOpenChange: () => {} }));
}

// Types a person into the people field and presses its + button, as a user picks someone.
async function pick(email: string) {
    const input = document.querySelector<HTMLInputElement>('#chat-wizard-people');
    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
    if (!input || !add) throw new Error('the wizard drew no people field');
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, email);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => add.click());
}

const buttonNamed = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);

test('each picked person has a remove button named after them, and it removes only them', async () => {
    await openWizard();
    await pick('ada@example.com');
    await pick('grace@example.com');

    const removeAda = buttonNamed('Remove ada@example.com');
    expect(removeAda).not.toBeNull();
    expect(buttonNamed('Remove grace@example.com')).not.toBeNull();
    expect(buttonNamed('Remove')).toBeNull();

    await act(async () => removeAda?.click());
    expect(buttonNamed('Remove ada@example.com')).toBeNull();
    expect(buttonNamed('Remove grace@example.com')).not.toBeNull();
});

test('a picked team has a remove button named after the team, and it goes back to picking people', async () => {
    await openWizard([DESIGN_TEAM]);
    const teamChat = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Team chat');
    await act(async () => {
        teamChat?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await clickRow('Design');

    const removeTeam = buttonNamed('Remove Design');
    expect(removeTeam).not.toBeNull();
    expect(buttonNamed('Remove')).toBeNull();

    await act(async () => removeTeam?.click());
    expect(buttonNamed('Remove Design')).toBeNull();
    expect(document.querySelector('#chat-wizard-people')).not.toBeNull();
});
