import {Button} from "@workspace/ui/components/button";
import {Tooltip, TooltipContent, TooltipTrigger,} from "@workspace/ui/components/tooltip";
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
}

export const TooltipButton = ({
                                  icon: Icon,
                                  tooltipText,
                                  onClick,
                                  size = "icon",
                                  variant = "ghost",
                                  className = "h-8 w-8",
                                  disabled = false,
                                  label = undefined
                              }: TooltipButtonProps) => {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <Button
                    variant={variant}
                    size={size}
                    className={className}
                    onClick={onClick}
                    disabled={disabled}
                >
                    <Icon className="h-4 w-4"/>
                    {label}
                </Button>
            </TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
        </Tooltip>
    );
};
