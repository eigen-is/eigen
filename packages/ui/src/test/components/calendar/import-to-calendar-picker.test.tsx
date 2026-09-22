// The one thing an .ics import needs that the other two do not: a target. What is pinned here is which
// calendars are offered (the home's own, plus a team calendar the viewer may write in — a calendar shared
// from another user's home is refused by the import route, so it is not on the list), the target the dialog
// hands `useImportToCalendar`, that the defaults land once, and that a list that would not load offers a
// retry rather than loading for ever. Making, filling and unmaking a new calendar is the hook's, pinned in
// packages/lib (src/test/core/calendar/hooks/use-transfer.test.ts).
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';

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
const served: { calendars: Calendar[] | undefined; isError: boolean } = { calendars, isError: false };

const realCalendarModule = await import('@workspace/lib/calendar');
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendarModule,
    useCalendars: () => ({ data: served.calendars, isError: served.isError, refetch: () => {} }),
    useSharedCalendars: () => ({ data: sharedCalendars }),
    useImportToCalendar: () => ({
        importToCalendar: async (_source: unknown, target: Target) => {
            handed.push(target);
        },
        forgetNewCalendar: () => {},
    }),
}));

mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: { id: 'owner-1' } }) }));
// useCalendarOptions resolves a team's name through this; there is no query client under this render.
mock.module('@workspace/lib/public', () => ({ usePublicUsers: () => ({ [TEAM]: { name: 'Marketing' } }) }));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ImportToCalendarPicker } = await import('../../../components/calendar/import-to-calendar-picker');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/calendar; method=REQUEST',
    filename: 'Autumn market.ics',
    size: 2048,
});

async function open() {
    handed = [];
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
        nameInput,
        openList,
        textsOf,
        trigger,
        typeName,
    };
}

test('the viewer’s own default calendar is preselected, and the import names their own home', async () => {
    const { click, closed, cleanup, dialog } = await open();
    expect(dialog().textContent).toContain('Home');

    await click('button', 'Import');
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
    expect(textsOf('[data-slot="select-label"]')).toEqual(['My Calendars', 'Team Calendars']);
    await cleanup();
});

test('a calendar the viewer only reads, and one shared from another user’s home, are no targets', async () => {
    const { cleanup, openList, textsOf } = await open();
    await openList();
    expect(textsOf('[role="option"]')).toEqual(['Work', 'Home', 'Marketing', 'New calendar']);
    await cleanup();
});

test('New calendar asks for one named after the file, in the viewer’s own home', async () => {
    const { chooseCalendar, click, cleanup, nameInput } = await open();
    await chooseCalendar('New calendar');
    expect(nameInput().value).toBe('Autumn market');

    await click('button', 'Import');
    expect(handed).toEqual([{ kind: 'new', name: 'Autumn market', color: expect.any(String) }]);
    await cleanup();
});

test('cancel imports nothing', async () => {
    const { closed, click, cleanup } = await open();
    await click('button', 'Cancel');
    expect(handed).toEqual([]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('while the calendars load there is no target to import into, and the default lands when they arrive', async () => {
    served.calendars = undefined;
    const { button, cleanup, dialog, draw, trigger } = await open();
    expect(dialog().textContent).toContain('Loading calendars');
    expect(trigger().disabled).toBe(true);
    expect(button('Import')?.disabled).toBe(true);

    served.calendars = calendars;
    await draw();
    expect(trigger().textContent).toContain('Home');
    expect(button('Import')?.disabled).toBe(false);
    await cleanup();
});

test('a later fetch of the calendars overwrites neither the chosen target nor the typed name', async () => {
    const { chooseCalendar, cleanup, draw, nameInput, typeName } = await open();
    await chooseCalendar('New calendar');
    await typeName('Market season');

    served.calendars = [...calendars];
    await draw();
    expect(nameInput().value).toBe('Market season');
    served.calendars = calendars;
    await cleanup();
});

test('a calendar list that would not load offers a retry instead of loading for ever', async () => {
    served.isError = true;
    const { button, cleanup, dialog } = await open();
    expect(dialog().textContent).toContain('Could not load your calendars');
    expect(dialog().textContent).not.toContain('Loading calendars');
    expect(button('Try again')).toBeDefined();
    expect(button('Import')?.disabled).toBe(true);

    served.isError = false;
    await cleanup();
});
