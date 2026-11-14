// The signed-in user as every app sees it, and what each app's router context carries: the user with the login and
// logout calls. The auth provider fills it from better-auth's session, and a route's beforeLoad reads it.

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
