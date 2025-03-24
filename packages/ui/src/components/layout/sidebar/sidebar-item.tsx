import {ReactNode} from 'react';
import {cn} from "../../../lib/utils";
import {Button} from "../../button";
import {Link} from '@tanstack/react-router';

export interface SidebarItemProps {
  icon: ReactNode;
  label?: string;
  to?: string;
  params?: Record<string, string>;
  isActive?: boolean;
  colorDot?: string;
  onClick?: () => void;
  condensed?: boolean;
  className?: string;
  children?: ReactNode;
}

export function SidebarItem({
  icon,
  label,
  to,
  params,
  isActive,
  colorDot,
  onClick,
  condensed = false,
  className,
  children,
}: SidebarItemProps) {
  // Common styling for both button and link variants
  const baseStyles = cn(
    "flex items-center rounded-md px-3 py-2 text-sm font-medium",
    condensed ? "justify-center" : "gap-3",
    isActive ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
    className
  );

  // Content to render inside the button or link
  const content = (
    <>
      {/* Color dot for labels */}
      {colorDot && (
        <span 
          className="h-3 w-3 rounded-full" 
          style={{ backgroundColor: colorDot }}
        />
      )}
      
      {/* Icon */}
      {icon}
      
      {/* Label text (only shown when not condensed) */}
      {!condensed && label && <span>{label}</span>}
      
      {/* Additional children */}
      {children}
    </>
  );

  // Render as a Link if 'to' is provided, otherwise as a Button
  if (to) {
    return (
      <Link
        to={to}
        params={params}
        className={baseStyles}
        activeProps={{
          className: 'bg-primary/10 text-primary',
        }}
        inactiveProps={{
          className: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        }}
        activeOptions={{ exact: false }}
      >
        {content}
      </Link>
    );
  }

  return (
    <Button
      variant="ghost"
      className={baseStyles}
      onClick={onClick}
    >
      {content}
    </Button>
  );
}
