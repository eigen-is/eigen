"use client"

import React from "react"
import { Toaster } from "@workspace/ui/components/sonner"
import { UploadProvider } from "./upload-provider/upload-provider"
import { AuthProvider } from "@workspace/lib/auth/auth-context.tsx"

interface EigenAppProps {
  children: React.ReactNode
}

/**
 * EigenApp provides a standardized application wrapper with all common providers
 * already configured - auth, upload tracking, and toasts.
 */
export function EigenApp({ children }: EigenAppProps) {
  return (
    <AuthProvider>
      <UploadProvider>
        {children}
        <Toaster />
      </UploadProvider>
    </AuthProvider>
  )
}
