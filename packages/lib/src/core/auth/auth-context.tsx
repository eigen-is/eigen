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

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({
    children,
    loadingFallback = null,
}: {
    children: ReactNode;
    loadingFallback?: ReactNode;
}): ReactNode {
    const [user, setUser] = useState<AuthUser | null>(null);
    // On the server there is no session to check and effects never run, so start
    // resolved — this lets SSR/prerender render children (unauthenticated) instead
    // of the loading fallback. In the browser we wait for the session check.
    const [isLoading, setIsLoading] = useState(typeof window !== 'undefined');
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
