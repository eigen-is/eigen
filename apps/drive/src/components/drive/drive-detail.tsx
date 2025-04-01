import {cn} from "@workspace/ui/lib/utils";

interface DriveDetailProps {
    path: any | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (path: any) => void;
}

export function DriveDetail({
                                path,
                                isMobile,
                                className,
                                onBackClick,
                                onDelete,
                                ...props
                            }: DriveDetailProps) {
    if (!path) {
        console.log('No email provided to EmailDetail component');
        return (
            <div className="flex h-full items-center justify-center text-muted-foreground">
                Path data not available
            </div>
        );
    }

    return (
        <div className={cn("flex flex-col h-full bg-white", className)} {...props}>
        </div>
    );
}
