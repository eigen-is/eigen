// The New chat wizard lists each picked person with an × that removes them, and with a team picked it shows the team
// with an × of its own. A screen reader hears each × by what it removes, never a row of bare "Remove"s, and a click
// removes only that one. A mouse user sees each × on hover only, and Tab reaches and shows it. The Location bar of the
// second step is a button that opens the folder browser, and a chat made after that goes into the folder it shows.
import { afterAll, expect, mock, test } from 'bun:test';
import { DRIVE_MIME_FOLDER } from '@workspace/lib/types/drive';
import { drivePath } from '../../drive-path';
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
const createdRooms: unknown[] = [];

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
    useCreateChatRoom: () => ({
        mutateAsync: async (room: unknown) => {
            createdRooms.push(room);
            return drivePath({ name: 'Ada & Me.eigenchat', mimeType: 'application/eigenchat' });
        },
        isPending: false,
    }),
    useFindChatByMembers: () => ({ data: [], isPending: false }),
}));
const realHome = { ...(await import('@workspace/lib/home')) };
mock.module('@workspace/lib/home', () => ({ ...realHome, useMyTeams: () => ({ data: myTeams }) }));
// The root of the viewer's drive, once it has loaded. The browser's other reads fail and draw an empty browser.
const driveRoot = drivePath({ id: 'root', name: 'Drive', mimeType: DRIVE_MIME_FOLDER, type: 'folder', ownerId: 'me' });
let rootLoaded = false;
const realDrive = { ...(await import('@workspace/lib/drive')) };
mock.module('@workspace/lib/drive', () => ({
    ...realDrive,
    useRootFolder: (ownerId: string) => ({ data: rootLoaded && ownerId ? driveRoot : undefined }),
}));
afterAll(() => {
    mock.module('@workspace/lib/auth', () => realAuth);
    mock.module('@workspace/lib/chat', () => realChat);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/home', () => realHome);
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement } = await import('react');
const { ChatCreateWizard } = await import('../../../components/chat/chat-create-wizard');
const { clickRow } = await import('../../menu-rows');
const { pressKey } = await import('../../press-key');
const { expectKeyboardReveal } = await import('../../hover-reveal');

async function openWizard(teams: (typeof DESIGN_TEAM)[] = []) {
    myTeams = teams;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await renderInDocument(
        createElement(
            QueryClientProvider,
            { client },
            createElement(ChatCreateWizard, { open: true, onOpenChange: () => {}, onNavigate: () => {} }),
        ),
    );
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

test("a picked person's × shows on hover only for a mouse, and Tab reaches and shows it", async () => {
    await openWizard();
    await pick('ada@example.com');
    const removeAda = buttonNamed('Remove ada@example.com');
    if (!removeAda) throw new Error('the wizard drew no remove button');
    expectKeyboardReveal(removeAda);
});

test('a picked team has a remove button named after the team, and it goes back to picking people', async () => {
    await openWizard([DESIGN_TEAM]);
    const teamChat = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Team chat');
    if (!teamChat) throw new Error('the wizard drew no Team chat button');
    await act(async () => {
        teamChat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await clickRow('Design');

    const removeTeam = buttonNamed('Remove Design');
    expect(removeTeam).not.toBeNull();
    expect(buttonNamed('Remove')).toBeNull();

    await act(async () => removeTeam?.click());
    expect(buttonNamed('Remove Design')).toBeNull();
    expect(document.querySelector('#chat-wizard-people')).not.toBeNull();
});

const letsChat = () => {
    const button = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === "Let's chat");
    if (!button) throw new Error("the wizard drew no Let's chat button");
    return button;
};

async function openSecondStep() {
    await openWizard();
    await pick('ada@example.com');
    // The first step waits for its debounced look for an existing chat with these people.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    await act(async () => letsChat().click());
}

test('the Location bar is a button named for what it does, and Enter on it opens the folder browser', async () => {
    await openSecondStep();

    const change = buttonNamed('Change location');
    if (!change) throw new Error('the Location bar is no button');
    expect(change.getAttribute('aria-expanded')).toBe('false');
    await act(async () => pressKey(change, 'Enter'));
    expect(document.querySelector('button[aria-label="Change location"][aria-expanded="true"]')).not.toBeNull();
});

test('a chat whose location was never opened names no folder, so the server picks the chats folder', async () => {
    createdRooms.length = 0;
    await openSecondStep();
    await act(async () => letsChat().click());
    expect(createdRooms).toEqual([expect.objectContaining({ parentId: undefined, members: ['ada@example.com'] })]);
});

test('once the location is opened, the chat waits for the drive’s root and goes into the folder shown', async () => {
    createdRooms.length = 0;
    rootLoaded = false;
    await openSecondStep();
    await act(async () => buttonNamed('Change location')?.click());
    expect(letsChat().disabled).toBe(true);
    await act(async () => letsChat().click());
    expect(createdRooms).toEqual([]);

    rootLoaded = true;
    // Closing the browser draws the wizard again, as the root's arrival does.
    await act(async () => buttonNamed('Change location')?.click());
    expect(letsChat().disabled).toBe(false);
    await act(async () => letsChat().click());
    expect(createdRooms).toEqual([expect.objectContaining({ parentId: 'root', members: ['ada@example.com'] })]);
});
