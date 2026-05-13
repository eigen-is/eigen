import { cn } from '@workspace/ui/lib/utils';
import { Loader2 } from 'lucide-react';

type ImagePlaceholderProps = {
    className?: string;
};

export function ImagePlaceholder({ className }: ImagePlaceholderProps) {
    return (
        <div
            className={cn(
                'flex items-center justify-center w-full h-full bg-muted text-muted-foreground rounded-sm',
                className,
            )}
        >
            <Loader2 className="h-6 w-6 animate-spin" />
        </div>
    );
}
