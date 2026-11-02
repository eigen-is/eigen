// The brand-colored button at the top of an app's sidebar that starts its main action, such as Compose or Create
// event. Condensed, it shows its icon alone. renderTrigger draws the icon and label inside the caller's own element,
// such as a link.

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
            className={cn('hover:opacity-90', condensed ? 'w-10 p-0' : 'w-full justify-start gap-3', className)}
            // The app's brand color, from the --sidebar-newbtn-* variables. Inline, so it wins over the utilities.
            style={{ backgroundColor: 'var(--sidebar-newbtn-bg)', color: 'var(--sidebar-newbtn-fg)' }}
            // Condensed, the icon stands alone, so the label is its name.
            aria-label={condensed ? label : undefined}
            {...props}
            asChild={!!renderTrigger}
        >
            {renderTrigger ? renderTrigger(content) : content}
        </Button>
    );
}
