// Draws every app in the user's theme: it reads the personal settings and puts the dark class on the page,
// following the computer's own setting for System. The choice is cached in the browser, so the inline
// THEME_FLASH_SCRIPT can draw the right theme before React loads, and so can this provider before the
// settings arrive.

import { useSpaceSettings } from '@workspace/lib/space';
import type { UserTheme } from '@workspace/lib/types/settings';
import { isUserTheme } from '@workspace/lib/types/settings';
import { useEffect } from 'react';

// Keep in sync with THEME_FLASH_SCRIPT, which reads the same cache.
function applyTheme(theme: UserTheme) {
    const isDark =
        theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.classList.toggle('dark', isDark);
    try {
        localStorage.setItem('eigen-theme', theme);
    } catch {}
}

function getCachedTheme(): UserTheme {
    try {
        const v = localStorage.getItem('eigen-theme');
        if (v && isUserTheme(v)) return v;
    } catch {}
    return 'light';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const { data: settings } = useSpaceSettings();
    const theme = settings?.theme ?? getCachedTheme();

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
