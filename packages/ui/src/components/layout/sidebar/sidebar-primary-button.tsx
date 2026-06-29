import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '../../button';

type SidebarPrimaryButtonProps = ComponentProps<typeof Button> & {
    icon: LucideIcon;
    label: string;
    condensed?: boolean;
    renderTrigger?: (content: ReactNode) => ReactNode;
};

export function SidebarPrimaryButton({
    icon: Icon,
    label,
    condensed = false,
    renderTrigger,
    className,
    ...props
}: SidebarPrimaryButtonProps) {
    const content = (
        <>
            <Icon className="h-4 w-4" />
            {!condensed && <span>{label}</span>}
        </>
    );

    return (
        <Button
            variant="ghost"
            size={condensed ? 'icon' : 'default'}
            // Carries the app's brand colour via --sidebar-newbtn-* (globals.css);
            // inline style so it beats the utility layer.
            className={cn('hover:opacity-90', condensed ? 'w-10 p-0' : 'w-full justify-start gap-3', className)}
            style={{ backgroundColor: 'var(--sidebar-newbtn-bg)', color: 'var(--sidebar-newbtn-fg)' }}
            {...props}
            asChild={!!renderTrigger}
        >
            {renderTrigger ? renderTrigger(content) : content}
        </Button>
    );
}
