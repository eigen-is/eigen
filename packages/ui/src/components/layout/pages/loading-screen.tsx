import { cn } from '../../../lib/utils.ts';
import { EigenLoader } from '../../braket/eigen-loader.tsx';

type LoadingScreenProps = {
    className?: string;
};

export function LoadingScreen({ className }: LoadingScreenProps) {
    return (
        <div className="fixed inset-0 flex items-center justify-center bg-background">
            <EigenLoader className={cn('text-muted-foreground', className)} />
        </div>
    );
}
