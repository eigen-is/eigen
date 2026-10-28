// Draws every app in the user's theme: it reads useTheme and puts the dark class on the page, following
// the computer's own setting for System. The inline THEME_FLASH_SCRIPT draws the same class from the
// browser's copy before React loads.

import { useTheme } from '@workspace/lib/space';
import type { UserTheme } from '@workspace/lib/types/settings';
import { useEffect } from 'react';

function applyTheme(theme: UserTheme) {
    const isDark =
        theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', isDark);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const { theme } = useTheme();

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
