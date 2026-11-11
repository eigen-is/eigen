// EigenApp is the root every Eigen app renders around its router: the hotkeys, the query client, auth, theme,
// the server event stream, uploads, previews and the command palette. It also keeps a file dropped
// outside a drop target from navigating the tab away, and binds the print key to print the open document.

import type { HotkeysProviderOptions } from '@tanstack/react-hotkeys';
import { HotkeysProvider, useHotkey } from '@tanstack/react-hotkeys';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@workspace/lib/auth';
import { PRINT_HOTKEY } from '@workspace/lib/constants/hotkeys';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type React from 'react';
import { useEffect, useState } from 'react';
import { printDocument } from '../../../lib/print-element';
import { PreviewProvider } from '../../preview-provider/preview-provider';
import { Toaster } from '../../sonner';
import { SSEProvider } from '../../sse-provider';
import { UploadProvider } from '../../upload-provider/upload-provider';
import { LoadingScreen } from '../pages/loading-screen';
import { CommandPaletteProvider } from './command-palette/command-palette-provider';
import { ErrorBoundary } from './error-boundary';
import { ThemeProvider } from './theme-provider';

// Two keymaps may register one key on the document, such as the canvas's nudges and the file preview's paging, each
// gated by `enabled`. The hotkey library counts a disabled registration as a conflict too, and warns on every register.
const HOTKEY_DEFAULTS: HotkeysProviderOptions = { hotkey: { conflictBehavior: 'allow' } };

type EigenAppProps = {
    children: React.ReactNode;
};

function GlobalHotkeys() {
    useHotkey(PRINT_HOTKEY, (e) => {
        e.preventDefault();
        printDocument();
    });
    return null;
}

export function EigenApp({ children }: EigenAppProps) {
    // A file dropped outside any wired drop target must never navigate the tab away (destroying the
    // session). Handled targets run first during bubble; this document-level preventDefault only
    // suppresses the browser's default file-open. Drops on editable targets are exempt: their
    // default IS the drop (text dragged into an input/contenteditable inserts), and canceling it
    // here would break that everywhere. ProseMirror editors handle drops themselves either way.
    useEffect(() => {
        const preventDragover = (e: DragEvent) => e.preventDefault();
        const preventDrop = (e: DragEvent) => {
            const t = e.target;
            if (t instanceof HTMLElement && (t.isContentEditable || t.closest('input, textarea'))) return;
            e.preventDefault();
        };
        document.addEventListener('dragover', preventDragover);
        document.addEventListener('drop', preventDrop);
        return () => {
            document.removeEventListener('dragover', preventDragover);
            document.removeEventListener('drop', preventDrop);
        };
    }, []);
    const [queryClient] = useState(
        () =>
            new QueryClient({
                defaultOptions: {
                    queries: {
                        staleTime: STALE_TIME.TWO_MINUTES,
                        retry: 1,
                    },
                },
            }),
    );

    return (
        <HotkeysProvider defaultOptions={HOTKEY_DEFAULTS}>
            <QueryClientProvider client={queryClient}>
                <AuthProvider loadingFallback={<LoadingScreen />}>
                    <ThemeProvider>
                        <SSEProvider>
                            <UploadProvider>
                                <PreviewProvider>
                                    <CommandPaletteProvider>
                                        <GlobalHotkeys />
                                        <ErrorBoundary>{children}</ErrorBoundary>
                                        <Toaster />
                                    </CommandPaletteProvider>
                                </PreviewProvider>
                            </UploadProvider>
                        </SSEProvider>
                    </ThemeProvider>
                </AuthProvider>
            </QueryClientProvider>
        </HotkeysProvider>
    );
}
