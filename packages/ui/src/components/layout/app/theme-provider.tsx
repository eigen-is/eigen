// Draws every app in the user's theme: it reads the personal settings and puts the dark class on the page,
// following the computer's own setting for System. The browser keeps a copy of the choice, so the inline
// THEME_FLASH_SCRIPT can draw the right theme before React loads, and so can this provider before the
// settings arrive.

import type { SettingWithCopy } from '@workspace/lib/space';
import { useSettingWithCopy } from '@workspace/lib/space';
import type { UserTheme } from '@workspace/lib/types/settings';
import { isUserTheme, themeOf } from '@workspace/lib/types/settings';
import { useEffect } from 'react';

// THEME_FLASH_SCRIPT reads the same key before any user is known, so the key is one for every user.
const THEME: SettingWithCopy<UserTheme> = {
    copyKey: () => 'eigen-theme',
    read: (settings) => settings.theme,
    patch: (theme) => ({ theme }),
    parse: (copy) => (isUserTheme(copy) ? copy : undefined),
    serialize: (theme) => theme,
};

function applyTheme(theme: UserTheme) {
    const isDark =
        theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const theme = useSettingWithCopy(THEME).value ?? themeOf(undefined);

    useEffect(() => {
        applyTheme(theme);

        if (theme !== 'system') return;

        const mq = window.matchMedia('(prefers-color-scheme: dark)');
        const handler = () => applyTheme('system');
        mq.addEventListener('change', handler);
        return () => mq.removeEventListener('change', handler);
    }, [theme]);

    return children;
}
