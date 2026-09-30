import { cn } from '@workspace/ui/lib/utils';
import { EigenLoader } from '../braket/eigen-loader';

type ImagePlaceholderProps = {
    className?: string;
};

// Shown while a media name resolves and also when it never will: telling the two apart needs the
// by-name resolver to track when its miss-triggered refetch has settled.
export function ImagePlaceholder({ className }: ImagePlaceholderProps) {
    return (
        <div className={cn('flex items-center justify-center w-full h-full bg-muted rounded-sm text-2xl', className)}>
            <EigenLoader />
        </div>
    );
}
