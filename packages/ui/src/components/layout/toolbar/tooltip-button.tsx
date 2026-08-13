import type { LucideIcon } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { Button } from '../../button';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip';

export type TooltipButtonProps = {
    icon: LucideIcon;
    tooltipText: string;
    onClick?: () => void;
    size?: 'default' | 'sm' | 'lg' | 'icon';
    variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost' | 'link';
    className?: string;
    disabled?: boolean;
    label?: string;
    active?: boolean;
    preventFocusLoss?: boolean;
    type?: 'button' | 'submit' | 'reset';
    form?: string;
};

export const TooltipButton = ({
    icon: Icon,
    tooltipText,
    onClick,
    size = 'icon',
    variant = 'ghost',
    className,
    disabled = false,
    label = undefined,
    active = false,
    preventFocusLoss = false,
    type,
    form,
}: TooltipButtonProps) => {
    const resolvedVariant = active ? 'secondary' : variant;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant={resolvedVariant}
                    size={size}
                    className={cn('h-8 w-8 cursor-pointer', className)}
                    disabled={disabled}
                    type={type}
                    form={form}
                    // Icon-only buttons have no text content — the tooltip text is the name.
                    aria-label={label ? undefined : tooltipText}
                    onClick={onClick}
                    // preventDefault blocks pointer focus transfer without canceling the click, so keyboard activation still fires.
                    onMouseDown={preventFocusLoss ? (e: React.MouseEvent) => e.preventDefault() : undefined}
                >
                    <Icon className="h-4 w-4" />
                    {label}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
    );
};
