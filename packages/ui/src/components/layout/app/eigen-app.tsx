import { TooltipProvider } from '@radix-ui/react-tooltip';
import { HotkeysProvider, useHotkey } from '@tanstack/react-hotkeys';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@workspace/lib/auth/auth-context.tsx';
import { STALE_TIME } from '@workspace/lib/constants/stale-time';
import type React from 'react';
import { lazy, Suspense, useState } from 'react';
import { printDocument } from '../../../lib/printElement.ts';
import { PreviewProvider } from '../../preview-provider/preview-provider.tsx';
import { Toaster } from '../../sonner.tsx';
import { SSEProvider } from '../../sse-provider';
import { UploadProvider } from '../../upload-provider/upload-provider.tsx';
import { LoadingScreen } from '../pages/loading-screen.tsx';
import { CommandPaletteProvider } from './command-palette/command-palette-provider.tsx';
import { ErrorBoundary } from './error-boundary.tsx';
import { ThemeProvider } from './theme-provider.tsx';

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
