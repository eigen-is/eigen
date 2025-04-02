"use client"

import React from "react"
import {Toaster} from "@workspace/ui/components/sonner"
import {UploadProvider} from "./upload-provider/upload-provider"
import {AuthProvider} from "@workspace/lib/auth/auth-context.tsx"
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {ReactQueryDevtools} from '@tanstack/react-query-devtools';

interface EigenAppProps {
    children: React.ReactNode
}

/**
 * EigenApp provides a standardized application wrapper with all common providers
 * already configured - auth, upload tracking, and toasts.
 */

// Create a QueryClient instance
const queryClient = new QueryClient();

export function EigenApp({children}: EigenAppProps) {
    return (
        <AuthProvider>
            <QueryClientProvider client={queryClient}>
                <UploadProvider>
                    {children}
                    <Toaster/>
                </UploadProvider>
                <ReactQueryDevtools initialIsOpen={false}/>
            </QueryClientProvider>
        </AuthProvider>
    )
}
