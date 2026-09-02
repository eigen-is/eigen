import { cn } from '../../../lib/utils';
import { EigenLoader } from '../../braket/eigen-loader';

type LoadingStateProps = {
    // Caption under the loader, for waits that need explaining (see CollabLoadingState).
    message?: string;
};

export function LoadingState({ message }: LoadingStateProps) {
    return (
        <div
            className={cn(
                'flex items-center justify-center h-full w-full',
                message && 'flex-col gap-4 p-8 text-center',
            )}
        >
            <EigenLoader />
            {message && <p className="text-sm text-muted-foreground">{message}</p>}
        </div>
    );
}
