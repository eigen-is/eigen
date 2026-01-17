"use client"

import React, {useState} from "react"
import {Toaster} from "@workspace/ui/components/sonner"
import {UploadProvider} from "./upload-provider/upload-provider"
import {AuthProvider} from "@workspace/lib/auth/auth-context.tsx"
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ReactQueryDevtools} from '@tanstack/react-query-devtools';
import {SSEProvider} from "./sse-provider";
import {TooltipProvider} from "@radix-ui/react-tooltip"
import {AppContext} from "./app-context"
import {usePrintDocument} from "@workspace/ui/hooks/use-print-document"

interface EigenAppProps {
    children: React.ReactNode;
    appName?: string;
}

/**
 * EigenApp provides a standardized application wrapper with all common providers
 * already configured - auth, upload tracking, and toasts.
 */

// Create a QueryClient instance
const queryClient = new QueryClient();

export function EigenApp({children, appName = ''}: EigenAppProps) {
    const [currentAppName, setCurrentAppName] = useState(appName);
    usePrintDocument();

    return (
        <TooltipProvider>
            <QueryClientProvider client={queryClient}>
                <AuthProvider>
                    <AppContext.Provider value={{
                        appName: currentAppName,
                        setAppName: setCurrentAppName
                    }}>
                        <SSEProvider>
                            <UploadProvider>
                                {children}
                                <Toaster/>
                            </UploadProvider>
                        </SSEProvider>
                    </AppContext.Provider>
                    <ReactQueryDevtools initialIsOpen={false}/>
                </AuthProvider>
            </QueryClientProvider>
        </TooltipProvider>
    )
}
