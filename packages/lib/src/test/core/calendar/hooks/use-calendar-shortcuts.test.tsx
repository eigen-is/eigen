// Calendar's keys, as Google's: t shows today, j and the right arrow to the next period, k and the left arrow to the
// previous one, d, x, w, m and a switch the view on the same day, and c creates. A key does nothing while the
// shortcuts are off, while the user types in a field, or with a modifier held.
import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import type { CalendarViewMode } from '@workspace/lib/types/calendar';
import { installHappyDom } from '../../../happy-dom';

const happyWindow = installHappyDom();
// The hotkey library tells a field from the page by these classes, so they are borrowed too, and put back after.
const fieldClasses = {
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    HTMLTextAreaElement: happyWindow.HTMLTextAreaElement,
    HTMLSelectElement: happyWindow.HTMLSelectElement,
};
const ownClasses = Object.fromEntries(Object.keys(fieldClasses).map((key) => [key, Reflect.get(globalThis, key)]));
Object.assign(globalThis, fieldClasses);
afterAll(() => Object.assign(globalThis, ownClasses));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useCalendarShortcuts } = await import('../../../../core/calendar/hooks/use-calendar-shortcuts');

const shown: [CalendarViewMode, string][] = [];
const show = (mode: CalendarViewMode, day: Date) => shown.push([mode, day.toDateString()]);
const showToday = mock(() => {});
const create = mock(() => {});

let unmount = async () => {};
afterEach(async () => {
    await unmount();
    shown.length = 0;
    showToday.mockClear();
    create.mockClear();
});

async function mount(enabled = true, mode: CalendarViewMode = 'week') {
    const root = createRoot(document.createElement('div'));
    function Harness() {
        useCalendarShortcuts({ mode, focus: new Date(2026, 9, 14), show, showToday, create, enabled });
        return null;
    }
    await act(async () => {
        root.render(<Harness />);
    });
    unmount = () => act(async () => root.unmount());
}

const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document) =>
    act(async () => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });

const day = (month: number, date: number) => new Date(2026, month, date).toDateString();

test('t shows today', async () => {
    await mount();
    await press('t');
    expect(showToday).toHaveBeenCalledTimes(1);
});

test('j and the right arrow go to the next period, k and the left arrow to the previous one', async () => {
    await mount();
    for (const key of ['j', 'ArrowRight', 'k', 'ArrowLeft']) await press(key);
    expect(shown).toEqual([
        ['week', day(9, 21)],
        ['week', day(9, 21)],
        ['week', day(9, 7)],
        ['week', day(9, 7)],
    ]);
});

test('d, x, w, m and a switch the view and keep the day', async () => {
    await mount(true, 'day');
    for (const key of ['d', 'x', 'w', 'm', 'a']) await press(key);
    expect(shown).toEqual([
        ['day', day(9, 14)],
        ['3day', day(9, 14)],
        ['week', day(9, 14)],
        ['month', day(9, 14)],
        ['schedule', day(9, 14)],
    ]);
});

test('c creates an event', async () => {
    await mount();
    await press('c');
    expect(create).toHaveBeenCalledTimes(1);
});

test('while the shortcuts are off no key acts', async () => {
    await mount(false);
    for (const key of ['t', 'j', 'ArrowRight', 'm', 'c']) await press(key);
    expect(shown).toEqual([]);
    expect(showToday).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
});

test('a key typed in a field stays in the field', async () => {
    await mount();
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    document.body.append(input, textarea);
    await press('m', {}, input);
    await press('c', {}, textarea);
    await press('ArrowLeft', {}, input);
    input.remove();
    textarea.remove();
    expect(shown).toEqual([]);
    expect(create).not.toHaveBeenCalled();
});

test('a key with a modifier held is left to the browser', async () => {
    await mount();
    await press('t', { metaKey: true });
    await press('c', { ctrlKey: true });
    await press('ArrowLeft', { altKey: true });
    await press('m', { shiftKey: true });
    expect(shown).toEqual([]);
    expect(create).not.toHaveBeenCalled();
});
