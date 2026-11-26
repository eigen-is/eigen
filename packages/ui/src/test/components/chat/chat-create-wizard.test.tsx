// The New chat wizard keeps the dialog contract on its second step, where Create makes the chat. It opens on the
// people field, and its second step on the name, selected. A person typed but not added counts as a change and is
// added by Next, and the user's own address says why it can't be added. A name another chat there has is said under
// the name, which gets the focus. It lists each picked person with an × that
// removes them, and with a team picked it shows the team with an × of its own. A screen reader hears each × by what it
// removes, never a row of bare "Remove"s, and a click removes only that one. A mouse user sees each × on hover only,
// and Tab reaches and shows it. The Location bar of the second step is a button that opens the folder browser, and a
// chat made after that goes into the folder it shows. A typed address that is one of the user's contacts names the
// chat by the contact's name.
import { afterAll, expect, mock, test } from 'bun:test';
import type { Contact } from '@workspace/lib/types/contact';
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
const createRoom = mock(async (room: unknown) => {
    createdRooms.push(room);
    return drivePath({ name: 'Ada & Me.eigenchat', mimeType: 'application/eigenchat' });
});
// One object, so the effects that depend on it settle.
const createRoomMutation = { mutateAsync: createRoom, isPending: false };

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
    useCreateChatRoom: () => createRoomMutation,
    useFindChatByMembers: () => ({ data: [], isPending: false }),
}));
const grace: Contact = {
    id: 'grace',
    etag: '',
    firstName: 'Grace',
    lastName: 'Hopper',
    email: ['Grace@example.com'],
    phone: [],
};
const realContacts = { ...(await import('@workspace/lib/contacts')) };
mock.module('@workspace/lib/contacts', () => ({ ...realContacts, useContacts: () => ({ data: [grace] }) }));
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
    mock.module('@workspace/lib/contacts', () => realContacts);
    mock.module('@workspace/lib/drive', () => realDrive);
    mock.module('@workspace/lib/home', () => realHome);
});

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { act, createElement, useState } = await import('react');
const { expectFormContract, type } = await import('../../form-contract');
const { ChatCreateWizard } = await import('../../../components/chat/chat-create-wizard');
const { clickRow } = await import('../../menu-rows');
const { pressKey } = await import('../../press-key');
const { expectKeyboardReveal } = await import('../../hover-reveal');

// The wizard as a host keeps it: open until it closes itself.
function HostedWizard() {
    const [open, setOpen] = useState(true);
    return createElement(ChatCreateWizard, { open, onOpenChange: setOpen, onNavigate: () => {} });
}

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
    await type('People', email);
    const add = document.querySelector<HTMLButtonElement>('button[aria-label="Add"]');
    if (!add) throw new Error('the wizard drew no + button');
    await act(async () => add.click());
}

// The first step waits for its debounced look for an existing chat with these people.
const lookUp = () => act(async () => new Promise((resolve) => setTimeout(resolve, 350)));

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

const button = (label: string) => {
    const found = [...document.querySelectorAll('button')].find((b) => b.lastChild?.textContent?.trim() === label);
    if (!found) throw new Error(`the wizard drew no ${label} button`);
    return found;
};
const create = () => button('Create');

async function goToSecondStep(...emails: string[]) {
    for (const email of emails.length ? emails : ['ada@example.com']) await pick(email);
    await lookUp();
    await act(async () => button('Next').click());
}

async function openSecondStep(...emails: string[]) {
    await openWizard();
    await goToSecondStep(...emails);
}

test('the second step keeps the dialog contract', async () => {
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(HostedWizard),
        submitLabel: 'Create',
        firstField: 'Name',
        onSubmit: createRoom,
        makeChanged: () => goToSecondStep(),
        makeInvalid: async () => {
            await goToSecondStep();
            await type('Name', ' ');
        },
        invalidField: 'Name',
        except: { focus: 'the dialog opens on the people field of step 1; the test below pins both steps' },
    });
    // Each probe waits out step 1's look for an existing chat.
}, 30_000);

test('the wizard opens on the people field, and its second step on the name, selected', async () => {
    await openWizard();
    expect(document.activeElement?.id).toBe('chat-wizard-people');
    await goToSecondStep('ada@example.com');
    const name = document.querySelector<HTMLInputElement>('#chat-wizard-name');
    expect(document.activeElement?.id).toBe('chat-wizard-name');
    expect([name?.selectionStart, name?.selectionEnd]).toEqual([0, name?.value.length]);
});

test('a person typed but not added counts as a change, and Next adds them before it goes on', async () => {
    await renderInDocument(createElement(HostedWizard));
    await type('People', 'ada@example.com');
    await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.textContent).toContain('Discard changes?');
    await act(async () => button('Keep editing').click());

    await act(async () => button('Next').click());
    expect(buttonNamed('Remove ada@example.com')).not.toBeNull();
    expect(document.querySelector('#chat-wizard-name')).toBeNull();
    await lookUp();
    await act(async () => button('Next').click());
    expect(document.querySelector('#chat-wizard-name')).not.toBeNull();
});

test('your own address is refused with the reason, and the text stays', async () => {
    await openWizard();
    await pick('me@example.com');
    const people = document.querySelector<HTMLInputElement>('#chat-wizard-people');
    expect(people?.value).toBe('me@example.com');
    expect(people?.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain('You are already in the chat');
});

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
    await act(async () => create().click());
    expect(createdRooms).toEqual([expect.objectContaining({ parentId: undefined, members: ['ada@example.com'] })]);
});

test('once the location is opened, the chat waits for the drive’s root and goes into the folder shown', async () => {
    createdRooms.length = 0;
    rootLoaded = false;
    await openSecondStep();
    await act(async () => buttonNamed('Change location')?.click());
    expect(create().disabled).toBe(true);
    await act(async () => create().click());
    expect(createdRooms).toEqual([]);

    rootLoaded = true;
    // Closing the browser draws the wizard again, as the root's arrival does.
    await act(async () => buttonNamed('Change location')?.click());
    expect(create().disabled).toBe(false);
    await act(async () => create().click());
    expect(createdRooms).toEqual([expect.objectContaining({ parentId: 'root', members: ['ada@example.com'] })]);
});

test("a typed contact's address names the chat by the contact, and an unknown one by its local part", async () => {
    await openSecondStep('ada@example.com', 'grace@example.com');
    expect(document.querySelector<HTMLInputElement>('#chat-wizard-name')?.value).toBe('ada & Grace Hopper');
});

test('a name another chat has is said under the name, which keeps the focus and the dialog', async () => {
    const { AppError } = await import('@workspace/lib/api-error');
    await openSecondStep();
    await type('Name', 'Plans');
    createRoom.mockImplementationOnce(async () => {
        throw new AppError({ error: { status: 409, value: 'Taken' }, status: 409 });
    });
    await act(async () => create().click());
    const name = document.querySelector('#chat-wizard-name');
    expect(name?.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement?.id).toBe('chat-wizard-name');
    expect(document.body.textContent).toContain('A chat named "Plans" already exists here.');
    await type('Name', 'Plans 2');
    expect(name?.getAttribute('aria-invalid')).toBeNull();
});
