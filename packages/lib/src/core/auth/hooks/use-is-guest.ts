import { useAuth } from '../auth-context';

export function useIsGuest() {
    const { user } = useAuth();
    return user?.role === 'guest';
}
