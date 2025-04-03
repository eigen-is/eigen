import React, {createContext, ReactNode, useEffect, useState} from 'react';
import {authClient} from "./hooks/use-auth-client.ts";
import {LoadingScreen} from '@workspace/ui/components/layout/loading-screen';
import {useQueryClient} from '@tanstack/react-query';

export type AuthContextType = {
    isAuthenticated: boolean;
    isLoading: boolean;
    user: any | null;
    login: (email: string, password: string) => Promise<{ success: boolean; error?: any }>;
    logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({children}: { children: ReactNode }): React.ReactElement {
    const [user, setUser] = useState<any | null>(null);
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
            } catch (error) {
                console.error('Authentication check failed:', error);
            } finally {
                setIsLoading(false);
            }
        };

        checkAuthStatus();
    }, []);

    const login = async (email: string, password: string) => {
        try {
            const {data, error} = await authClient.signIn.email({
                email,
                password,
            });

            if (error) {
                return {success: false, error};
            }

            if (data) {
                setUser(data.user);
                return {success: true};
            }

            return {success: false, error: {message: 'Unknown error'}};
        } catch (error) {
            return {success: false, error};
        }
    };

    const logout = async () => {
        try {
            await authClient.signOut();
            setUser(null);
            queryClient.removeQueries();
        } catch (error) {
            console.error('Logout failed:', error);
        }
    };

    return isLoading ? <LoadingScreen/> : (
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
    const context = React.useContext(AuthContext)
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider')
    }
    return context
}
