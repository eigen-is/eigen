import React, {useState} from "react"
import {Toaster} from "../../sonner.tsx"
import {UploadProvider} from "../upload-provider/upload-provider.tsx"
import {PreviewProvider} from "../preview-provider/preview-provider.tsx"
import {AuthProvider} from "@workspace/lib/auth/auth-context.tsx"
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ReactQueryDevtools} from '@tanstack/react-query-devtools';
import {SSEProvider} from "../sse-provider";
import {TooltipProvider} from "@radix-ui/react-tooltip"
import {HotkeysProvider, useHotkey} from "@tanstack/react-hotkeys"
import {printDocument} from "../../../lib/printElement.ts"
import {ThemeProvider} from "./theme-provider.tsx"

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
                                        {children}
                                        <Toaster/>
                                    </PreviewProvider>
                                </UploadProvider>
                            </SSEProvider>
                        </ThemeProvider>
                        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-left"/>
                    </AuthProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </HotkeysProvider>
    )
}
