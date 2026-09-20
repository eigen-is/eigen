// The one thing an .ics import needs that the other two do not: a target. What is pinned here is which
// calendars are offered (the home's own — a calendar shared with the viewer lives in another home and
// the import route refuses it), and that "New calendar" creates before it imports.
import { expect, mock, test } from 'bun:test';
import { subjectFromMailAttachment } from '@workspace/lib/file-subject';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

type ImportCall = { calendarId: string; url?: string };

const calls: { created: string[]; imported: ImportCall[] } = { created: [], imported: [] };
const calendars = [
    { id: 'cal-work', name: 'Work', color: '#111111', isDefault: false },
    { id: 'cal-home', name: 'Home', color: '#222222', isDefault: true },
];

const realCalendarModule = await import('@workspace/lib/calendar');
mock.module('@workspace/lib/calendar', () => ({
    ...realCalendarModule,
    // The picker asks for the home's own calendars only; useSharedCalendars is never reached from here.
    useCalendars: () => ({ data: calendars }),
    useCreateCalendar: () => ({
        mutateAsync: async ({ name }: { name: string }) => {
            calls.created.push(name);
            return { id: 'cal-new' };
        },
    }),
    useImportCalendarFromDrive: () => ({
        mutateAsync: async (input: ImportCall) => {
            calls.imported.push(input);
        },
    }),
    useImportCalendarFromUrl: () => ({
        mutateAsync: async (input: ImportCall) => {
            calls.imported.push(input);
        },
    }),
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
    const closed = { count: 0 };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
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

    // Radix portals each dialog to the body, so a test that opened one before scopes to the newest.
    const dialog = () => [...document.querySelectorAll('[role="dialog"]')].at(-1) as HTMLElement;
    const click = async (selector: string, label: string) => {
        const target = [...dialog().querySelectorAll(selector)].find((el) => el.textContent?.trim() === label);
        if (!target) throw new Error(`no "${label}" ${selector}; saw ${dialog().textContent}`);
        await act(async () => {
            target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const chooseCalendar = async (label: string) => {
        const trigger = dialog().querySelector('[data-slot="select-trigger"]');
        await act(async () => {
            trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
            trigger?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const option = [...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === label);
        if (!option) throw new Error(`no "${label}" option`);
        await act(async () => {
            option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
            option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return { closed, click, chooseCalendar, cleanup, dialog };
}

test('the home’s own calendars are the targets, the default one preselected', async () => {
    const { click, closed, cleanup, dialog } = await open();
    expect(dialog().textContent).toContain('Home');

    await click('button', 'Import');
    expect(calls.created).toEqual([]);
    expect(calls.imported.map((call) => call.calendarId)).toEqual(['cal-home']);
    expect(closed.count).toBe(1);
    await cleanup();
});

test('New calendar creates one named after the file, then imports into it', async () => {
    const { chooseCalendar, click, cleanup, dialog } = await open();
    await chooseCalendar('New calendar');
    expect(dialog().querySelector('input')?.value).toBe('Autumn market');

    await click('button', 'Import');
    expect(calls.created).toEqual(['Autumn market']);
    expect(calls.imported.map((call) => call.calendarId)).toEqual(['cal-new']);
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
