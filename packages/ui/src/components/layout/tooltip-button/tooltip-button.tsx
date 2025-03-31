import { Button } from "@workspace/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import { LucideIcon } from "lucide-react";

export interface TooltipButtonProps {
  /**
   * The icon to display in the button
   */
  icon: LucideIcon;
  
  /**
   * The text to display in the tooltip
   */
  tooltipText: string;
  
  /**
   * The function to call when the button is clicked
   */
  onClick?: () => void;
  
  /**
   * The size of the button
   * @default "icon"
   */
  size?: "default" | "sm" | "lg" | "icon";
  
  /**
   * The variant of the button
   * @default "ghost"
   */
  variant?: "default" | "destructive" | "outline" | "secondary" | "ghost" | "link";
  
  /**
   * Additional class names to apply to the button
   * @default "h-8 w-8"
   */
  className?: string;
  
  /**
   * Whether the button is disabled
   * @default false
   */
  disabled?: boolean;
}

export const TooltipButton = ({
  icon: Icon,
  tooltipText,
  onClick,
  size = "icon",
  variant = "ghost",
  className = "h-8 w-8",
  disabled = false,
}: TooltipButtonProps) => {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant={variant}
            size={size}
            className={className}
            onClick={onClick}
            disabled={disabled}
          >
            <Icon className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{tooltipText}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};
