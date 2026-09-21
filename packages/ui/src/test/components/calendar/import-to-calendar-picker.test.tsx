// The one thing an .ics import needs that the other two do not: a target. What is pinned here is which
// calendars are offered (the home's own, plus a team calendar the viewer may write in — a calendar shared
// from another user's home is refused by the import route, so it is not on the list), which home each
// target names, that "New calendar" creates before it imports, that the defaults land once, that a retry
// after a failed import reuses the calendar the first attempt created, that a list that would not load
// offers a retry rather than loading for ever, and that a new calendar nothing landed in goes again.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

type ImportCall = { ownerId: string; calendarId: string; url?: string };
type ImportCounts = { imported: number; skipped: number; failed: number };
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

const calls: { created: string[]; imported: ImportCall[]; deleted: string[] } = {
    created: [],
    imported: [],
    deleted: [],
};
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
// What the hooks answer for the render under test: the list may not have arrived, and an import may fail.
const served: {
    calendars: Calendar[] | undefined;
    isError: boolean;
    failNextImport: boolean;
    counts: ImportCounts;
} = {
    calendars,
    isError: false,
    failNextImport: false,
    counts: { imported: 2, skipped: 0, failed: 0 },
};

const importOnce = async (input: ImportCall): Promise<ImportCounts> => {
    if (served.failNextImport) {
        served.failNextImport = false;
        throw new Error('import failed');
    }
    calls.imported.push(input);
    return served.counts;
};

const realCalendarModule = await import('@workspace/lib/calendar');
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendarModule,
    useCalendars: () => ({ data: served.calendars, isError: served.isError, refetch: () => {} }),
    useSharedCalendars: () => ({ data: sharedCalendars }),
    // The real one resolves a team's name over the network; here the team home stands in for it.
    useSharedCalendarLabel: () => (sc: Shared) => (sc.ownerUserId === TEAM ? 'Marketing' : sc.calendarName),
    useCreateCalendar: () => ({
        mutateAsync: async ({ name }: { name: string }) => {
            calls.created.push(name);
            return { id: 'cal-new' };
        },
    }),
    useDeleteCalendar: () => ({
        mutateAsync: async (id: string) => {
            calls.deleted.push(id);
        },
    }),
    useImportCalendar: () => ({ mutateAsync: importOnce }),
}));

mock.module('@workspace/lib/auth', () => ({ useAuth: () => ({ user: { id: 'owner-1' } }) }));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { ImportToCalendarPicker } = await import('../../../components/calendar/import-to-calendar-picker');

const subject = subjectFromMailAttachment('owner-1', 'message-1', 0, {
    contentType: 'text/calendar; method=REQUEST',
    filename: 'Autumn market.ics',
    size: 2048,
});

async function open() {
    calls.created = [];
    calls.imported = [];
    calls.deleted = [];
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
    expect(calls.created).toEqual([]);
    expect(calls.imported.map((call) => [call.ownerId, call.calendarId])).toEqual([['owner-1', 'cal-home']]);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('a team calendar the viewer may write in is a target, named after its team, under its own heading', async () => {
    const { chooseCalendar, click, cleanup, trigger } = await open();
    await chooseCalendar('Marketing');
    expect(trigger().textContent).toContain('Marketing');

    await click('button', 'Import');
    expect(calls.imported.map((call) => [call.ownerId, call.calendarId])).toEqual([[TEAM, 'cal-team']]);
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

test('New calendar creates one named after the file in the viewer’s own home, then imports into it', async () => {
    const { chooseCalendar, click, cleanup, nameInput } = await open();
    await chooseCalendar('New calendar');
    expect(nameInput().value).toBe('Autumn market');

    await click('button', 'Import');
    expect(calls.created).toEqual(['Autumn market']);
    expect(calls.imported.map((call) => [call.ownerId, call.calendarId])).toEqual([['owner-1', 'cal-new']]);
    await cleanup();
});

test('cancel imports nothing', async () => {
    const { closed, click, cleanup } = await open();
    await click('button', 'Cancel');
    expect(calls.created).toEqual([]);
    expect(calls.imported).toEqual([]);
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

test('a retry after a failed import reuses the calendar the first attempt created', async () => {
    served.failNextImport = true;
    const { chooseCalendar, click, cleanup } = await open();
    await chooseCalendar('New calendar');

    await click('button', 'Import');
    expect(calls.imported).toEqual([]);

    await click('button', 'Import');
    expect(calls.created).toEqual(['Autumn market']);
    expect(calls.imported.map((call) => call.calendarId)).toEqual(['cal-new']);
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

test('a new calendar nothing landed in goes again', async () => {
    served.counts = { imported: 0, skipped: 4, failed: 0 };
    const { chooseCalendar, click, cleanup } = await open();
    await chooseCalendar('New calendar');

    await click('button', 'Import');
    expect(calls.created).toEqual(['Autumn market']);
    expect(calls.deleted).toEqual(['cal-new']);

    served.counts = { imported: 2, skipped: 0, failed: 0 };
    await cleanup();
});

test('a calendar that took the file is kept', async () => {
    const { chooseCalendar, click, cleanup } = await open();
    await chooseCalendar('New calendar');

    await click('button', 'Import');
    expect(calls.deleted).toEqual([]);
    await cleanup();
});
