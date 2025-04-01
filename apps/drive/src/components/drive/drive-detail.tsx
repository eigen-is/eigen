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
            <div className="p-6">
                <h2 className="text-xl font-medium mb-2">{path.name}</h2>
                <div className="text-sm text-muted-foreground mb-4">
                    <p>Type: {path.type}</p>
                    <p>Mime: {path.mimeType}</p>
                    <p>ACLS: {JSON.stringify(path.acl || [])}</p>
                    {path.size && <p>Size: {path.size} bytes</p>}
                    {path.createdAt && <p>Created: {new Date(path.createdAt).toLocaleDateString()}</p>}
                </div>
            </div>
        </div>
    );
}
