"use client"

import React from "react"
import {Toaster} from "@workspace/ui/components/sonner"
import {UploadProvider} from "./upload-provider/upload-provider"
import {AuthProvider} from "@workspace/lib/auth/auth-context.tsx"
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ReactQueryDevtools} from '@tanstack/react-query-devtools';
import {SSEProvider} from "./sse-provider";
import {TooltipProvider} from "@radix-ui/react-tooltip"
import {HotkeysProvider, useHotkey} from "@tanstack/react-hotkeys"
import {printDocument} from "@workspace/ui/lib/printElement"

interface EigenAppProps {
    children: React.ReactNode;
}

// Create a QueryClient instance
const queryClient = new QueryClient();

function GlobalHotkeys() {
    useHotkey('Mod+P', (e) => {
        e.preventDefault();
        printDocument();
    });
    return null;
}

export function EigenApp({children}: EigenAppProps) {
    return (
        <HotkeysProvider>
            <TooltipProvider>
                <QueryClientProvider client={queryClient}>
                    <AuthProvider>
                        <SSEProvider>
                            <UploadProvider>
                                <GlobalHotkeys/>
                                {children}
                                <Toaster/>
                            </UploadProvider>
                        </SSEProvider>
                        <ReactQueryDevtools initialIsOpen={false}/>
                    </AuthProvider>
                </QueryClientProvider>
            </TooltipProvider>
        </HotkeysProvider>
    )
}
