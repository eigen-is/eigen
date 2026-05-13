import { cn } from '@workspace/ui/lib/utils';
import { EigenLoader } from '../braket/eigen-loader';

type ImagePlaceholderProps = {
    className?: string;
};

export function ImagePlaceholder({ className }: ImagePlaceholderProps) {
    return (
        <div className={cn('flex items-center justify-center w-full h-full bg-muted rounded-sm text-2xl', className)}>
            <EigenLoader />
        </div>
    );
}
