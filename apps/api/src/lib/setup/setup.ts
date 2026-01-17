import { auth } from "../auth/auth";

export async function hasAnyUsers(): Promise<boolean> {
    try {
        const result = await auth.api.listUsers({
            query: { limit: 1 }
        });
        return result.users.length > 0;
    } catch (error) {
        console.log('User check failed, assuming no users exist:', error);
        return false;
    }
}

export async function createFirstAdminUser(email: string, password: string, name: string) {
    try {
        const result = await auth.api.createUser({
            body: {
                email,
                password,
                name,
                role: 'admin',
            }
        });

        if (!result) {
            throw new Error('Failed to create user');
        }

        return {
            success: true,
            user: result
        };
    } catch (error) {
        console.error('Failed to create first admin user:', error);
        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error'
        };
    }
}

export async function isSetupRequired(): Promise<boolean> {
    return !(await hasAnyUsers());
}
