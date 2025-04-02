import {ReactNode} from 'react';
import {cn} from "../../../lib/utils";

export interface SidebarSectionProps {
    title?: string;
    children: ReactNode;
    condensed?: boolean;
    className?: string;
}

export function SidebarSection({
                                   title,
                                   children,
                                   condensed = false,
                                   className,
                               }: SidebarSectionProps) {
    return (
        <div className={cn("px-3 py-2", className)}>
            {title && (
                <div className={cn(
                    "flex items-center mb-2",
                    condensed ? "justify-center" : "justify-between"
                )}>
                    {!condensed && (
                        <h3 className="text-sm font-medium text-muted-foreground">
                            {title}
                        </h3>
                    )}
                    {condensed && (
                        <span className="text-sm font-medium text-muted-foreground">
              {title[0]}
            </span>
                    )}
                </div>
            )}
            <div className="space-y-1">
                {children}
            </div>
        </div>
    );
}
