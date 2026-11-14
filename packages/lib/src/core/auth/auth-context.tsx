// The signed-in user for every app. AuthProvider reads the session through better-auth's client and shares it, with
// login and logout, through useAuth. The router context of each app carries the same value, so a route's
// beforeLoad can check it before anything renders.

import { useQueryClient } from '@tanstack/react-query';
import type { AuthContextType, AuthUser } from '@workspace/lib/types/auth';
import type { ReactNode } from 'react';
import React, { createContext, useEffect, useState } from 'react';
import { authClient } from './hooks/use-auth-client';

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
    children,
    loadingFallback = null,
}: {
    children: ReactNode;
    loadingFallback?: ReactNode;
}): ReactNode {
    const [user, setUser] = useState<AuthUser | null>(null);
    // isLoading is true until the session check answers, on the server and the first client render too, so what waits
    // for it matches the prerender. Only a loadingFallback blocks the children on it, as the SPA shell's does.
    const [isLoading, setIsLoading] = useState(true);
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

    return isLoading && loadingFallback != null && typeof window !== 'undefined' ? (
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
