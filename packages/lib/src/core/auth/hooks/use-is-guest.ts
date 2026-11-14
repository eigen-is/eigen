import { useAuth } from '../auth-context';

export function useIsGuest(): boolean {
    const { user } = useAuth();
    return user?.role === 'guest';
}
