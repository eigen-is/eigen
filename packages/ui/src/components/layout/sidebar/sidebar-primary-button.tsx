import { cn } from '@workspace/ui/lib/utils';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../button';

type SidebarPrimaryButtonProps = {
    icon: LucideIcon;
    label: string;
    condensed?: boolean;
    onClick?: () => void;
    renderTrigger?: (content: ReactNode) => ReactNode;
};

export function SidebarPrimaryButton({
    icon: Icon,
    label,
    condensed = false,
    onClick,
    renderTrigger,
}: SidebarPrimaryButtonProps) {
    const content = (
        <>
            <Icon className="h-4 w-4" />
            {!condensed && <span>{label}</span>}
        </>
    );

    return (
        <div className="px-3 py-2">
            <Button
                variant="default"
                size={condensed ? 'icon' : 'default'}
                className={cn(condensed ? 'w-10 p-0' : 'w-full justify-start gap-3')}
                onClick={onClick}
                asChild={!!renderTrigger}
            >
                {renderTrigger ? renderTrigger(content) : content}
            </Button>
        </div>
    );
}
