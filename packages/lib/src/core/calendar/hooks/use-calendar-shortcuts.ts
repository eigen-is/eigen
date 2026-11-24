// Calendar's keyboard shortcuts, Google Calendar's keys: t for today, j and k or the arrows to step a period, a letter
// per view, and c to create. Calendar's toolbar binds them once, on the whole page, and turns them off while a dialog
// is open. The hotkey library leaves a key typed in a field to the field, and a key with a modifier to the browser.

import { useHotkey } from '@tanstack/react-hotkeys';
import type { CalendarViewMode } from '../calendar-view';
import { stepFocus } from '../calendar-view';

type CalendarShortcuts = {
    mode: CalendarViewMode;
    focus: Date;
    show: (mode: CalendarViewMode, day: Date) => void;
    showToday: () => void;
    create: () => void;
    enabled: boolean;
};

export function useCalendarShortcuts({ mode, focus, show, showToday, create, enabled }: CalendarShortcuts): void {
    const options = { enabled };
    const next = () => show(mode, stepFocus(mode, focus, 1));
    const previous = () => show(mode, stepFocus(mode, focus, -1));

    useHotkey('T', showToday, options);
    useHotkey('J', next, options);
    useHotkey('ArrowRight', next, options);
    useHotkey('K', previous, options);
    useHotkey('ArrowLeft', previous, options);
    useHotkey('D', () => show('day', focus), options);
    // Google's x is its custom view, which is 3 days here.
    useHotkey('X', () => show('3day', focus), options);
    useHotkey('W', () => show('week', focus), options);
    useHotkey('M', () => show('month', focus), options);
    useHotkey('A', () => show('schedule', focus), options);
    useHotkey('C', create, options);
}
