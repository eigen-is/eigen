import { useCommandPalette } from '@workspace/lib/command-palette';
import { useEffect } from 'react';

// Captures Mod+K from anywhere — including inside other inputs. The palette is the
// project's only Mod+K consumer (verified) so the global capture is safe.
export function usePaletteShortcuts(): void {
    const { setOpen } = useCommandPalette();
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (mod && (e.key === 'k' || e.key === 'K')) {
                e.preventDefault();
                setOpen((prev) => !prev);
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [setOpen]);
}
