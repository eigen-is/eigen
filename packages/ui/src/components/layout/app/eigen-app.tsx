import { TooltipProvider } from '@radix-ui/react-tooltip';
import { HotkeysProvider, useHotkey } from '@tanstack/react-hotkeys';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@workspace/lib/auth';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type React from 'react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { printDocument } from '../../../lib/printElement';
import { PreviewProvider } from '../../preview-provider/preview-provider';
import { Toaster } from '../../sonner';
import { SSEProvider } from '../../sse-provider';
import { UploadProvider } from '../../upload-provider/upload-provider';
import { LoadingScreen } from '../pages/loading-screen';
import { CommandPaletteProvider } from './command-palette/command-palette-provider';
import { ErrorBoundary } from './error-boundary';
import { ThemeProvider } from './theme-provider';

const ReactQueryDevtools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-query-devtools').then((m) => ({ default: m.ReactQueryDevtools })))
    : () => null;

type EigenAppProps = {
    children: React.ReactNode;
};

function GlobalHotkeys() {
    useHotkey('Mod+P', (e) => {
        e.preventDefault();
        printDocument();
    });
    return null;
}

export function EigenApp({ children }: EigenAppProps) {
    // A file dropped outside any wired drop target must never navigate the tab away (destroying the
    // session). Handled targets run first during bubble; this document-level preventDefault only
    // suppresses the browser's default file-open.
    useEffect(() => {
        const prevent = (e: DragEvent) => e.preventDefault();
        document.addEventListener('dragover', prevent);
        document.addEventListener('drop', prevent);
        return () => {
            document.removeEventListener('dragover', prevent);
            document.removeEventListener('drop', prevent);
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
        <HotkeysProvider>
            <TooltipProvider>
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
                        <Suspense>
                            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left" />
                        </Suspense>
                    </AuthProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </HotkeysProvider>
    );
}
