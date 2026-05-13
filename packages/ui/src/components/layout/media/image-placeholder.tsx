import { cn } from '@workspace/ui/lib/utils';

type ImagePlaceholderProps = {
    className?: string;
};

export function ImagePlaceholder({ className }: ImagePlaceholderProps) {
    return <div className={cn('w-full h-full bg-muted rounded-sm', className)} />;
}
