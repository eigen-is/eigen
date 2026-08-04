import { useQueryClient } from '@tanstack/react-query';
import React, { createContext, type ReactNode, useEffect, useState } from 'react';
import { authClient } from './hooks/use-auth-client';

export type AuthUser = {
    id: string;
    email: string;
    name: string;
    image?: string | null;
    role?: string | null;
    emailVerified: boolean;
    createdAt: Date;
    updatedAt: Date;
};

export type AuthContextType = {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: AuthUser | null;
    login: (email: string, password: string) => Promise<{ success: boolean; error?: unknown }>;
    logout: () => Promise<void>;
};

// Router context every app's createRootRouteWithContext shares.
export type RouterAppContext = { auth: AuthContextType };

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
    children,
    loadingFallback = null,
}: {
    children: ReactNode;
    loadingFallback?: ReactNode;
}): ReactNode {
    const [user, setUser] = useState<AuthUser | null>(null);
    // Blocking the app on the browser session check is opt-in via loadingFallback.
    // The SPA shell (eigen-app.tsx) passes one, so it shows a loading screen until
    // the session resolves. The prerendered index site passes none: it must render
    // children on the very first client render too — matching the server-rendered
    // HTML so React hydrates it in place instead of discarding it and appending a
    // second copy. The session check still runs; it just updates `user` afterwards
    // (e.g. swapping the Topbar to its signed-in state). On the server window is
    // undefined, so every app renders children (unauthenticated) at build time.
    const [isLoading, setIsLoading] = useState(loadingFallback != null && typeof window !== 'undefined');
    const queryClient = useQueryClient();

    useEffect(() => {
        // Check if user is already authenticated on mount
        const checkAuthStatus = async () => {
            try {
                const session = await authClient.getSession();
                if (session.data) {
                    setUser(session.data.user);
                }
            } catch {
            } finally {
                setIsLoading(false);
            }
        };

        checkAuthStatus();
    }, []);

    const login = async (email: string, password: string) => {
        try {
            const { data, error } = await authClient.signIn.email({
                email,
                password,
            });

            if (error) {
                return { success: false, error };
            }

            if (data) {
                setUser(data.user);
                await authClient.getSession();
                return { success: true };
            }

            return { success: false, error: { message: 'Unknown error' } };
        } catch (error) {
            return { success: false, error };
        }
    };

    const logout = async () => {
        try {
            await authClient.signOut();
            setUser(null);
            queryClient.removeQueries();
        } catch {}
    };

    return isLoading ? (
        loadingFallback
    ) : (
        <AuthContext.Provider
            value={{
                isAuthenticated: !!user,
                isLoading,
                user,
                login,
                logout,
            }}
        >
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = React.useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider');
    }
    return context;
}
