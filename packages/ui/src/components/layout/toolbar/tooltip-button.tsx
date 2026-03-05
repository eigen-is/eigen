import {Button} from "@workspace/ui/components/button.tsx";
import {Tooltip, TooltipContent, TooltipTrigger,} from "@workspace/ui/components/tooltip.tsx";
import {LucideIcon} from "lucide-react";

export type TooltipButtonProps = {
    icon: LucideIcon;
    tooltipText: string;
    onClick?: () => void;
    size?: "default" | "sm" | "lg" | "icon";
    variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
    className?: string;
    disabled?: boolean;
    label?: string;
    active?: boolean;
    preventFocusLoss?: boolean;
}

export const TooltipButton = ({
                                  icon: Icon,
                                  tooltipText,
                                  onClick,
                                  size = "icon",
                                  variant = "ghost",
                                  className = "h-8 w-8",
                                  disabled = false,
                                  label = undefined,
                                  active = false,
                                  preventFocusLoss = false,
                              }: TooltipButtonProps) => {
    const resolvedVariant = active ? "secondary" : variant;

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant={resolvedVariant}
                    size={size}
                    className={className}
                    disabled={disabled}
                    {...(preventFocusLoss
                        ? {
                            onMouseDown: (e: React.MouseEvent) => {
                                e.preventDefault();
                                onClick?.();
                            },
                        }
                        : {onClick}
                    )}
                >
                    <Icon className="h-4 w-4"/>
                    {label}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
    );
};
