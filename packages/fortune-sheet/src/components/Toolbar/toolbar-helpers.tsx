import { useState } from "react";
import { Button } from "@workspace/ui/components/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@workspace/ui/components/popover";
import { ColorPicker } from "@workspace/ui/components/layout/media/color-picker";
import { Separator } from "@workspace/ui/components/separator";
import {ChevronDown} from "lucide-react";
import {ICON_MAP} from "../icon-map";

export {ICON_MAP} from "../icon-map";
import {SVGIcon} from "../icon-map";


export function ToolbarSeparator() {
  return <Separator orientation="vertical" className="h-6 mx-1" />;
}

export function ToolbarIcon({
  name,
  className = "h-4 w-4",
}: {
  name: string;
  className?: string;
}) {
  const Icon = ICON_MAP[name];
  if (Icon) return <Icon className={className} />;
  return <SVGIcon name={name} />;
}

export function ColorCombo({
  name,
  tooltip,
  recentColor,
  onPick,
}: {
  name: string;
  tooltip: string;
  recentColor: string | undefined;
  onPick: (color: string | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const Icon = ICON_MAP[name];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex flex-col items-center">
                {Icon ? (
                  <Icon className="h-4 w-4" />
                ) : (
                  <SVGIcon name={name} />
                )}
                <div
                  className="h-0.5 w-4 rounded-full mt-px"
                  style={{
                    backgroundColor: recentColor || "#000",
                  }}
                />
              </div>
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="start">
        <ColorPicker
          value={recentColor ?? ""}
          resetLabel="Default"
          onChange={(color) => {
            onPick(color || undefined);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

export function ToolbarDropdown({
  iconId,
  text,
  tooltip,
  onClick,
  children,
}: {
  iconId?: string;
  text?: string;
  tooltip: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  if (onClick) {
    return (
      <div className="flex items-center">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-r-none"
              onClick={onClick}
            >
              {iconId ? (
                <ToolbarIcon name={iconId} />
              ) : (
                <span className="text-xs whitespace-nowrap">{text ?? ""}</span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-4 px-0 rounded-l-none"
            >
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[75vh] overflow-auto"
          >
            {children}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-8 px-2 gap-1">
              {iconId ? (
                <ToolbarIcon name={iconId} />
              ) : (
                <span className="text-xs whitespace-nowrap">{text ?? ""}</span>
              )}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="max-h-[75vh] overflow-auto"
      >
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ToolbarMenuButton({
  iconId,
  tooltip,
  children,
}: {
  iconId: string;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onMouseDown={(e) => e.preventDefault()}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <ToolbarIcon name={iconId} />
            </TooltipTrigger>
            <TooltipContent>{tooltip}</TooltipContent>
          </Tooltip>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[75vh] overflow-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
