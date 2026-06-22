import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { Button } from '../../button';

type SidebarPrimaryButtonProps = ComponentProps<typeof Button> & {
    icon: LucideIcon;
    label: string;
    condensed?: boolean;
    /** Wrap the button content in a custom trigger, e.g. a router `<Link>`. */
    renderTrigger?: (content: ReactNode) => ReactNode;
};

/**
 * The sidebar's primary action button ("New", "Compose", "Create …"). Carries
 * the per-app accent through `.bg-app`. Horizontal/vertical spacing is owned by
 * the sidebar's `.app-gutter` container, so this adds none of its own. It
 * forwards all Button props/ref, so it can be used directly, wrapped via
 * `renderTrigger`, or as an `asChild` dropdown trigger.
 */
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
            variant="default"
            size={condensed ? 'icon' : 'default'}
            className={cn(
                'bg-app text-white hover:bg-app hover:opacity-90',
                condensed ? 'w-10 p-0' : 'w-full justify-start gap-3',
                className,
            )}
            {...props}
            asChild={!!renderTrigger}
        >
            {renderTrigger ? renderTrigger(content) : content}
        </Button>
    );
}
