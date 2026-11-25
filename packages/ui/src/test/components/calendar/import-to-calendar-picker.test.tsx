// The one thing an .ics import needs that the other two do not: a target. The dialog keeps the dialog contract. What is
// pinned here is which calendars are offered: the home's own, plus a team calendar the viewer may write in. A calendar
// shared from another user's home is refused by the import route, so it is not on the list. Also pinned: the file and
// target the dialog hands `useImportToCalendar`, that a later fetch overwrites no choice, that a failure keeps the
// dialog open, that a new calendar with no name or a calendar that went away says so under its field, and that a list
// still loading or that would not load shows only Close, with a retry for the one that failed. Making, filling and
// deleting a new calendar is the hook's, pinned in packages/lib's use-transfer test.
import { expect, mock, test } from 'bun:test';
import { importSourceOf, subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { expectFormContract } from '../../form-contract';
import { installHappyDom } from '../../happy-dom';
import { pressEnter } from '../../press-enter';

installHappyDom();

type Calendar = { id: string; name: string; color: string; isDefault: boolean };
type Shared = {
    id: string;
    ownerUserId: string;
    calendarId: string;
    calendarName: string;
    calendarColor: string;
    permission: 'free-busy' | 'read' | 'write';
    color: string | null;
    visible: boolean;
};

// Where the dialog says the file goes, in the vocabulary the hook takes.
type Target = { kind: 'existing'; ownerId: string; calendarId: string } | { kind: 'new'; name: string; color: string };

let handed: Target[] = [];
// The files handed with each target, which this dialog passes on as the file action gave them.
let sources: unknown[] = [];
// A failure the hook has already toasted, as useImportToCalendar's mutations do; null imports.
let failure: Error | null = null;
const refetch = mock(() => {});
const calendars: Calendar[] = [
    { id: 'cal-work', name: 'Work', color: '#111111', isDefault: false },
    { id: 'cal-home', name: 'Home', color: '#222222', isDefault: true },
];
// Homes are parsed, so these read like the real thing: a 32-character id, team ones behind `team_`.
const TEAM = `team_${'t1'.padEnd(32, '0')}`;
const READ_ONLY_TEAM = `team_${'t2'.padEnd(32, '0')}`;
const MATE = 'ada'.padEnd(32, '0');

// A team calendar the viewer writes in, one they only read, and one shared out of another user's home.
const sharedCalendars: Shared[] = [
    {
        id: 's1',
        ownerUserId: TEAM,
        calendarId: 'cal-team',
        calendarName: 'Calendar',
        calendarColor: '#333333',
        permission: 'write',
        color: null,
        visible: true,
    },
    {
        id: 's2',
        ownerUserId: READ_ONLY_TEAM,
        calendarId: 'cal-read',
        calendarName: 'Read only',
        calendarColor: '#444444',
        permission: 'read',
        color: null,
        visible: true,
    },
    {
        id: 's3',
        ownerUserId: MATE,
        calendarId: 'cal-mate',
        calendarName: 'Ada’s plans',
        calendarColor: '#555555',
        permission: 'write',
        color: null,
        visible: true,
    },
];
// What the hooks answer for the render under test: the list may not have arrived.
const served: { calendars: Calendar[] | undefined; sharedCalendars: Shared[]; isError: boolean } = {
    calendars,
    sharedCalendars,
    isError: false,
};

const importToCalendar = mock(async (source: unknown, target: Target) => {
    sources.push(source);
    handed.push(target);
    if (failure) throw failure;
});
const realCalendarModule = await import('@workspace/lib/calendar');
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendarModule,
    useCalendars: () => ({ data: served.calendars, isError: served.isError, refetch }),
    useSharedCalendars: () => ({ data: served.sharedCalendars }),
    useImportToCalendar: () => ({ importToCalendar }),
}));

const session = { user: { id: 'owner-1' } };
const realAuth = await import('@workspace/lib/auth');
mock.module('@workspace/lib/auth', () => ({ ...realAuth, useAuth: () => session }));
// useCalendarOptions resolves a team's name through this; there is no query client under this render.
const realPublic = await import('@workspace/lib/public');
mock.module('@workspace/lib/public', () => ({
    ...realPublic,
    usePublicUsers: () => ({ [TEAM]: { name: 'Marketing' } }),
}));

const { onMutationError } = await import('@workspace/lib/api-error');
const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ImportToCalendarPicker } = await import('../../../components/calendar/import-to-calendar-picker');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/calendar; method=REQUEST',
    filename: 'Autumn market.ics',
    size: 2048,
});

// Radix portals each dialog to the body, so a test that opened one before scopes to the newest.
const dialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) as HTMLElement;
const button = (label: string) =>
    [...dialog().querySelectorAll('button')].find((el) => el.textContent?.trim() === label);
const click = async (selector: string, label: string) => {
    const target = [...dialog().querySelectorAll(selector)].find((el) => el.textContent?.trim() === label);
    if (!target) throw new Error(`no "${label}" ${selector}; saw ${dialog().textContent}`);
    await act(async () => {
        target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};
const trigger = () => dialog().querySelector('[data-slot="select-trigger"]') as HTMLButtonElement;
// Radix portals the open list to the body too, so everything read out of it scopes to the newest one.
const list = () => [...document.querySelectorAll('[data-slot="select-content"]')].at(-1) as HTMLElement;
const openList = async () => {
    await act(async () => {
        trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        trigger().dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};
const textsOf = (selector: string) => [...list().querySelectorAll(selector)].map((el) => el.textContent?.trim());
const chooseCalendar = async (label: string) => {
    await openList();
    const option = [...list().querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === label);
    if (!option) throw new Error(`no "${label}" option`);
    await act(async () => {
        option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
        option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
};
const nameInput = () => dialog().querySelector('input') as HTMLInputElement;
const typeName = async (value: string) => {
    const input = nameInput();
    // React reads the value off its own tracker, so the native setter is what a keystroke looks like.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    await act(async () => {
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
};
const enter = async () => {
    await act(async () => pressEnter(nameInput()));
};

// The picker under a host that owns `open`, as a file action does.
function Picker() {
    const [open, setOpen] = useState(true);
    return createElement(ImportToCalendarPicker, { subject, open, onClose: () => setOpen(false) });
}

async function open() {
    handed = [];
    sources = [];
    refetch.mockClear();
    const closed = { count: 0 };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const draw = async () => {
        await act(async () => {
            root.render(
                createElement(ImportToCalendarPicker, {
                    subject,
                    open: true,
                    onClose: () => {
                        closed.count += 1;
                    },
                }),
            );
        });
    };
    await draw();

    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return {
        closed,
        button,
        click,
        chooseCalendar,
        cleanup,
        dialog,
        draw,
        enter,
        nameInput,
        openList,
        textsOf,
        trigger,
        typeName,
    };
}

const fieldError = () => dialog().querySelector('[data-slot="field-error"]')?.textContent;

test('Import to Calendar keeps the dialog contract', async () => {
    handed = [];
    await expectFormContract({
        kind: 'dialog',
        render: () => createElement(Picker),
        submitLabel: 'Import',
        firstField: 'Add to calendar',
        onSubmit: importToCalendar,
        makeChanged: async () => {
            await chooseCalendar('New calendar');
            await typeName('Market season');
        },
        makeInvalid: async () => {
            await chooseCalendar('New calendar');
            await typeName(' ');
        },
        invalidField: 'Calendar name',
        except: {
            // Reported against the shared Select.
            modEnter: "the Select's trigger opens its list on Cmd+Enter as well as submitting",
        },
    });
});

test('the dialog names the file and offers a calendar under Add to calendar, with a name field only for a new one', async () => {
    const { chooseCalendar, cleanup, dialog, trigger } = await open();
    expect(dialog().querySelector('h2')?.textContent).toBe('Import to Calendar');
    expect(dialog().textContent).toContain('Pick the calendar “Autumn market.ics” lands in.');
    expect(trigger().textContent).toContain('Home');
    expect(dialog().querySelector(`label[for="${trigger().id}"]`)?.textContent).toBe('Add to calendar');
    expect(dialog().querySelector('input')).toBeNull();

    await chooseCalendar('New calendar');
    expect(dialog().querySelector('label[for="import-calendar-name"]')?.textContent).toBe('Calendar name');
    expect(dialog().querySelector('input')?.id).toBe('import-calendar-name');
    await cleanup();
});

test('the viewer’s own default calendar is preselected, and the import names their own home', async () => {
    const { click, closed, cleanup, dialog } = await open();
    expect(dialog().textContent).toContain('Home');

    await click('button', 'Import');
    expect(sources).toEqual([importSourceOf(subject)]);
    expect(handed).toEqual([{ kind: 'existing', ownerId: 'owner-1', calendarId: 'cal-home' }]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('a team calendar the viewer may write in is a target, named after its team, under its own heading', async () => {
    const { chooseCalendar, click, cleanup, trigger } = await open();
    await chooseCalendar('Marketing');
    expect(trigger().textContent).toContain('Marketing');

    await click('button', 'Import');
    expect(handed).toEqual([{ kind: 'existing', ownerId: TEAM, calendarId: 'cal-team' }]);
    await cleanup();
});

test('the two headings the sidebar uses group the targets', async () => {
    const { cleanup, openList, textsOf } = await open();
    await openList();
    expect(textsOf('[data-slot="select-label"]')).toEqual(['My calendars', 'Team calendars']);
    await cleanup();
});

test('a calendar the viewer only reads, and one shared from another user’s home, are no targets', async () => {
    const { cleanup, openList, textsOf } = await open();
    await openList();
    expect(textsOf('[role="option"]')).toEqual(['Work', 'Home', 'Marketing', 'New calendar']);
    await cleanup();
});

test('New calendar asks for one named after the file, in the viewer’s own home', async () => {
    const { chooseCalendar, click, closed, cleanup, nameInput } = await open();
    await chooseCalendar('New calendar');
    expect(nameInput().value).toBe('Autumn market');

    await click('button', 'Import');
    expect(sources).toEqual([importSourceOf(subject)]);
    expect(handed).toEqual([{ kind: 'new', name: 'Autumn market', color: expect.any(String) }]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('Enter in the new calendar’s name imports into a calendar of that name, trimmed', async () => {
    const { chooseCalendar, closed, cleanup, enter, typeName } = await open();
    await chooseCalendar('New calendar');
    await typeName('  Market season ');

    await enter();
    expect(handed).toEqual([{ kind: 'new', name: 'Market season', color: expect.any(String) }]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('a new calendar with no name says "Add a name" under the field, and imports nothing', async () => {
    const { chooseCalendar, click, closed, cleanup, enter, typeName } = await open();
    await chooseCalendar('New calendar');
    await typeName('   ');
    await click('button', 'Import');
    expect(fieldError()).toBe('Add a name');
    await enter();
    expect(handed).toEqual([]);
    expect(closed.count).toBe(0);
    await cleanup();
});

test('an import that fails keeps the dialog open with the calendar and name still chosen', async () => {
    failure = new Error('offline');
    // The hook's mutation toasts its failure before the dialog sees it.
    onMutationError(failure);
    const { button, chooseCalendar, click, closed, cleanup, nameInput, trigger, typeName } = await open();
    await chooseCalendar('New calendar');
    await typeName('Market season');

    await click('button', 'Import');
    expect(handed).toEqual([{ kind: 'new', name: 'Market season', color: expect.any(String) }]);
    expect(closed.count).toBe(0);
    expect(trigger().textContent).toContain('New calendar');
    expect(nameInput().value).toBe('Market season');
    expect(button('Import')?.getAttribute('aria-busy')).toBeNull();

    failure = null;
    await cleanup();
});

test('a calendar that went away after it was chosen says "Pick a calendar" until another is picked', async () => {
    const { chooseCalendar, click, closed, cleanup, draw, trigger } = await open();
    await chooseCalendar('Marketing');

    served.sharedCalendars = [];
    await draw();
    expect(trigger().textContent).toBe('Select calendar');
    await click('button', 'Import');
    expect(fieldError()).toBe('Pick a calendar');
    expect(trigger().getAttribute('aria-invalid')).toBe('true');
    expect(handed).toEqual([]);
    expect(closed.count).toBe(0);

    await chooseCalendar('Work');
    expect(fieldError()).toBeUndefined();
    await click('button', 'Import');
    expect(handed).toEqual([{ kind: 'existing', ownerId: 'owner-1', calendarId: 'cal-work' }]);
    served.sharedCalendars = sharedCalendars;
    await cleanup();
});

test('cancel imports nothing', async () => {
    const { closed, click, cleanup } = await open();
    await click('button', 'Cancel');
    expect(handed).toEqual([]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('while the calendars load there is only Close, and the default lands when they arrive', async () => {
    served.calendars = undefined;
    const { button, cleanup, dialog, draw, trigger } = await open();
    expect(dialog().textContent).toContain('Loading calendars');
    expect(trigger().disabled).toBe(true);
    expect(button('Import')).toBeUndefined();
    expect(button('Close')).toBeDefined();

    served.calendars = calendars;
    await draw();
    expect(trigger().textContent).toContain('Home');
    expect(button('Import')).toBeDefined();
    await cleanup();
});

test('a later fetch of the calendars overwrites neither the chosen target nor the typed name', async () => {
    const { chooseCalendar, cleanup, draw, nameInput, trigger, typeName } = await open();
    await chooseCalendar('New calendar');
    await typeName('Market season');

    served.calendars = [...calendars];
    await draw();
    expect(trigger().textContent).toContain('New calendar');
    expect(nameInput().value).toBe('Market season');
    served.calendars = calendars;
    await cleanup();
});

test('a calendar list that would not load offers a retry instead of loading for ever', async () => {
    served.isError = true;
    const { button, click, closed, cleanup, dialog } = await open();
    expect(dialog().textContent).toContain('Could not load your calendars');
    expect(dialog().textContent).not.toContain('Loading calendars');
    expect(button('Import')).toBeUndefined();

    await click('button', 'Try again');
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(handed).toEqual([]);
    expect(closed.count).toBe(0);

    served.isError = false;
    await cleanup();
});
