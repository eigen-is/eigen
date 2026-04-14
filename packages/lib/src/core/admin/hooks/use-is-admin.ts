import { useAuth } from '../../auth/auth-context';

export function useIsAdmin() {
    const { user } = useAuth();
    return user?.role === 'admin';
}
