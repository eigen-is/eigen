import { useEffect, useState } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

function useTheme(): 'light' | 'dark' {
    const [theme, setTheme] = useState<'light' | 'dark'>(() =>
        document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );

    useEffect(() => {
        const observer = new MutationObserver(() => {
            setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
        });
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        return () => observer.disconnect();
    }, []);

    return theme;
}

const Toaster = ({ ...props }: ToasterProps) => {
    const theme = useTheme();

    return (
        <Sonner
            theme={theme}
            className="toaster group"
            style={
                {
                    '--normal-bg': 'var(--popover)',
                    '--normal-text': 'var(--popover-foreground)',
                    '--normal-border': 'var(--border)',
                } as React.CSSProperties
            }
            {...props}
        />
    );
};

export { Toaster };
