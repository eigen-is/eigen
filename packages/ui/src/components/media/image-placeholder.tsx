import { cn } from '@workspace/ui/lib/utils';
import { ImageOff } from 'lucide-react';
import { EigenLoader } from '../braket/eigen-loader';

type ImagePlaceholderProps = {
    className?: string;
    // Draw the missing look instead of the loader.
    missing?: boolean;
};

export function ImagePlaceholder({ className, missing }: ImagePlaceholderProps) {
    return (
        <div className={cn('flex items-center justify-center w-full h-full bg-muted rounded-sm text-2xl', className)}>
            {missing ? (
                <ImageOff role="img" aria-label="Image not found" className="h-6 w-6 text-muted-foreground" />
            ) : (
                <EigenLoader />
            )}
        </div>
    );
}
