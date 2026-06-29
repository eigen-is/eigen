import { useSpaceSettings } from '@workspace/lib/space';
import { useEffect } from 'react';

// Keep in sync with themeFlashPlugin() in vite.shared.config.ts
function applyTheme(theme: 'light' | 'dark' | 'system') {
    const isDark =
        theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    document.documentElement.classList.toggle('dark', isDark);
    try {
        localStorage.setItem('eigen-theme', theme);
    } catch {}
}

function getCachedTheme(): 'light' | 'dark' | 'system' {
    try {
        const v = localStorage.getItem('eigen-theme');
        if (v === 'light' || v === 'dark' || v === 'system') return v;
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
