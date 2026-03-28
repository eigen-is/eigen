import type { LucideIcon } from 'lucide-react';
import { ToggleGroupItem } from '../../toggle-group.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../tooltip.tsx';

export type TooltipToggleProps = {
    icon: LucideIcon;
    tooltipText: string;
    value: string;
    pressed?: boolean;
    disabled?: boolean;
    className?: string;
    onClick?: () => void;
    'aria-label'?: string;
};

export const TooltipToggle = ({
    icon: Icon,
    tooltipText,
    value,
    pressed: _pressed,
    disabled = false,
    className = 'h-8 w-8',
    onClick,
    'aria-label': ariaLabel,
}: TooltipToggleProps) => {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <ToggleGroupItem
                    value={value}
                    className={className}
                    disabled={disabled}
                    aria-label={ariaLabel || tooltipText}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onClick?.();
                    }}
                >
                    <Icon className="h-4 w-4" />
                </ToggleGroupItem>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
    );
};
