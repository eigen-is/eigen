import React, {lazy, Suspense, useState} from "react"
import {Toaster} from "../../sonner.tsx"
import {UploadProvider} from "../upload-provider/upload-provider.tsx"
import {PreviewProvider} from "../preview-provider/preview-provider.tsx"
import {AuthProvider} from "@workspace/lib/auth/auth-context.tsx"
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {SSEProvider} from "../sse-provider";
import {TooltipProvider} from "@radix-ui/react-tooltip"
import {HotkeysProvider, useHotkey} from "@tanstack/react-hotkeys"
import {printDocument} from "../../../lib/printElement.ts"
import {ThemeProvider} from "./theme-provider.tsx"
import {ErrorBoundary} from "../../error-boundary.tsx"

const ReactQueryDevtools = import.meta.env.DEV
    ? lazy(() => import('@tanstack/react-query-devtools').then(m => ({default: m.ReactQueryDevtools})))
    : () => null;

type EigenAppProps = {
    children: React.ReactNode;
}

function GlobalHotkeys() {
    useHotkey('Mod+P', (e) => {
        e.preventDefault();
        printDocument();
    });
    return null;
}

export function EigenApp({children}: EigenAppProps) {
    const [queryClient] = useState(() => new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 2 * 60 * 1000,
                retry: 1,
            },
        },
    }));

    return (
        <HotkeysProvider>
            <TooltipProvider>
                <QueryClientProvider client={queryClient}>
                    <AuthProvider>
                        <ThemeProvider>
                            <SSEProvider>
                                <UploadProvider>
                                    <PreviewProvider>
                                        <GlobalHotkeys/>
                                        <ErrorBoundary>
                                            {children}
                                        </ErrorBoundary>
                                        <Toaster/>
                                    </PreviewProvider>
                                </UploadProvider>
                            </SSEProvider>
                        </ThemeProvider>
                        <Suspense>
                            <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left"/>
                        </Suspense>
                    </AuthProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </HotkeysProvider>
    )
}
