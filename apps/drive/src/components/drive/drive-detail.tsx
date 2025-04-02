import {cn} from "@workspace/ui/lib/utils";
import {ArrowLeft, Download, MoreVertical, Trash2, X} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {Button} from "@workspace/ui/components/button";
import {TooltipButton} from "@workspace/ui";

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
            {/* Action toolbar */}
            <div className="h-12 flex items-center justify-between px-4 border-b">
                <div className="flex items-center gap-1">
                    {/* Mobile back button when needed */}
                    {onBackClick && (
                        <>
                            <Button variant="ghost" size="icon" className="h-8 w-8 mr-1" onClick={onBackClick}
                                    title="Back">
                                {isMobile ? <ArrowLeft className="h-4 w-4"/> : <X className="h-4 w-4"/>}
                            </Button>
                            <div className="h-6 w-[1px] bg-border mx-1"></div>
                        </>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    {/* Right side icons */}
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        onClick={() => onDelete(path)}
                    />
                    <TooltipButton
                        icon={Download}
                        tooltipText="Download"
                        onClick={() => {
                            if (path && path.id) {
                                const downloadUrl = `${import.meta.env.VITE_API_HOST}/drive/download/${path.id}`;
                                // Create a temporary anchor element to trigger the download
                                const a = document.createElement('a');
                                a.href = downloadUrl;
                                a.download = path.name || 'download'; // Use the file name or a default
                                document.body.appendChild(a);
                                a.click();
                                document.body.removeChild(a);
                            }
                        }}
                    />

                    <div className="h-6 w-[1px] bg-border mx-1"></div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                                <MoreVertical className="h-4 w-4"/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem>Add label</DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <div className="p-4 flex-1 overflow-auto">
                <h2 className="text-xl font-medium mb-2">{path.name}</h2>
                <div className="text-sm text-muted-foreground mb-4">
                    <p>Type: {path.type}</p>
                    <p>Mime: {path.mimeType}</p>
                    <p>ACLS: {JSON.stringify(path.acl || [])}</p>
                    {path.size && <p>Size: {path.size} bytes</p>}
                    {path.createdAt && <p>Created: {new Date(path.createdAt).toLocaleDateString()}</p>}
                </div>
                {path.thumbnail && (
                    <div className="mt-4">
                        <img
                            src={`${import.meta.env.VITE_API_HOST}/drive/thumb/${path.thumbnail}`}
                            alt={`Thumbnail for ${path.name}`}
                            className="max-w-full max-h-[25%] object-contain"
                        />
                    </div>
                )}
            </div>
        </div>
    );
}
