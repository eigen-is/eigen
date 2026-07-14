import { useAuth } from '@workspace/lib/auth';
import { usePublicConfig } from '@workspace/lib/public';

export function DemoBanner() {
    const { data: config } = usePublicConfig();
    const { user } = useAuth();

    if (!config?.demoMode) return null;

    const firstName = user?.name?.split(' ')[0];

    return (
        <div className="shrink-0 border-b bg-muted px-4 py-1 text-center text-xs text-muted-foreground">
            {firstName
                ? `Shared demo workspace. You are exploring as ${firstName}. Everything resets every hour.`
                : 'Shared demo workspace. Everything resets every hour.'}
        </div>
    );
}
