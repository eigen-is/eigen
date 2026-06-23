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

// Keep in sync with themeFlashPlugin() in vite.shared.config.ts
function applyChrome(chrome: 'theme' | 'app') {
    document.documentElement.dataset.chrome = chrome;
    try {
        localStorage.setItem('eigen-chrome', chrome);
    } catch {}
}

function getCachedChrome(): 'theme' | 'app' {
    try {
        const v = localStorage.getItem('eigen-chrome');
        if (v === 'theme' || v === 'app') return v;
    } catch {}
    return 'app';
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
    const { data: settings } = useSpaceSettings();
    const theme = settings?.theme ?? getCachedTheme();
    const chrome = settings?.chromeStyle ?? getCachedChrome();

    useEffect(() => {
        applyChrome(chrome);
    }, [chrome]);

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
