import {type ReactNode} from "react";

type EmptyStateProps = {
    message?: string;
    icon?: ReactNode;
    action?: ReactNode;
};

export function EmptyState({
    message = "Within this void, all possibilities are yet unobserved.",
    icon,
    action,
}: EmptyStateProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full w-full gap-4 p-8 text-center">
            {icon && <div className="text-muted-foreground">{icon}</div>}
            <p className="text-muted-foreground">{message}</p>
            {action}
        </div>
    );
}
