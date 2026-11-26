// The Calendar view a user last picked, such as week or month, which Calendar's start page opens on. A phone and a
// computer each keep their own, since a phone shows fewer days at once. It lives in the user's settings, so it follows
// them to every device, and a copy in this browser opens the view before the settings load.

import type { CalendarViewMode } from '@workspace/lib/types/calendar';
import { CALENDAR_VIEW_MODES } from '@workspace/lib/types/calendar';
import type { CalendarViewLayout } from '@workspace/lib/types/settings';
import { useIsMobile } from '../../media';
import type { SettingWithCopy } from '../../space/hooks/use-setting-with-copy';
import { useSettingWithCopy } from '../../space/hooks/use-setting-with-copy';

const DEFAULTS: Record<CalendarViewLayout, CalendarViewMode> = { desktop: 'week', phone: '3day' };

const viewSetting = (layout: CalendarViewLayout): SettingWithCopy<CalendarViewMode> => ({
    copyKey: (ownerId) => `eigen-calendar-view:${layout}:${ownerId || 'anon'}`,
    read: (settings) => settings.calendarView?.[layout],
    patch: (mode) => ({ calendarView: { [layout]: mode } }),
    parse: (copy) => CALENDAR_VIEW_MODES.find((mode) => mode === copy),
    serialize: (mode) => mode,
});

// Built once, since the hook keys its read of the copy on the setting.
const VIEW_SETTINGS: Record<CalendarViewLayout, SettingWithCopy<CalendarViewMode>> = {
    desktop: viewSetting('desktop'),
    phone: viewSetting('phone'),
};

export function useCalendarViewPreference(): { mode: CalendarViewMode; setMode: (mode: CalendarViewMode) => void } {
    const layout = useIsMobile() ? 'phone' : 'desktop';
    const { value, save } = useSettingWithCopy(VIEW_SETTINGS[layout]);
    return {
        mode: value ?? DEFAULTS[layout],
        // Against the stored pick, not the default, so a pick made while the settings load still saves.
        setMode: (next) => {
            if (next !== value) save(next);
        },
    };
}
