import {cn} from "@workspace/ui/lib/utils";
import {ArrowLeft, Download, Link, MoreVertical, Share, Share2, Trash2, X} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {Button} from "@workspace/ui/components/button";
import {TooltipButton} from "@workspace/ui";
import {EigenLoader} from "@workspace/ui";
import {DriveAccessList, getFileIcon} from "@workspace/ui/components/layout/drive";
import {type DrivePath} from "@apps/api-server/types/drive";
import { formatFileSize } from "@workspace/ui/lib/formatFileSize";
import {
    Table,
    TableBody,
    TableCell,
    TableRow
} from "@workspace/ui/components/table";

interface DriveDetailProps {
    path: any | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (path: any) => void;
    onShareClick?: (item: DrivePath) => void;   
}

export function DriveDetail({
                                path,
                                isMobile,
                                className,
                                onBackClick,
                                onDelete,
                                onShareClick,
                                ...props
                            }: DriveDetailProps) {

    if (!path) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader />
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
                    <TooltipButton onClick={onBackClick}
                            tooltipText={isMobile ? "Back" : "Close"} 
                            icon={isMobile ? ArrowLeft : X}
                            />
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
                        icon={Link}
                        tooltipText="Edit Access"
                        onClick={() => {
                            onShareClick?.(path);
                        }}
                    />
                    <TooltipButton
                        icon={Download}
                        tooltipText="Download"
                        onClick={() => {
                            if (path && path.id) {
                                const downloadUrl = `${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`;
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
            <h2 className="text-xl font-medium mb-2 flex items-center">
  <span className="truncate overflow-hidden min-w-0 flex-1">{path.name}</span>
</h2>
                <Table className="text-sm text-muted-foreground mb-4">
                    <TableBody>
                        <TableRow>
                            <TableCell className="font-medium px-0 w-20">Mime</TableCell>
                            <TableCell className="px truncate">{path.mimeType}</TableCell>
                        </TableRow>
                        <TableRow>
                            <TableCell className="font-medium px-0">Size</TableCell>
                            <TableCell className="px">{formatFileSize(path.size)}</TableCell>
                        </TableRow>
                        {path.createdAt && (
                            <TableRow>
                                <TableCell className="font-medium px-0">Created</TableCell>
                                <TableCell className="px">{new Date(path.createdAt).toLocaleDateString()}</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
                {path.thumbnail && (
                    <div>
                        <img
                            src={`${import.meta.env.VITE_API_HOST}/drive/thumb/${path.ownerId}/${path.thumbnail}`}
                            alt={`Thumbnail for ${path.name}`}
                            className="max-w-full max-h-[25%] object-contain"
                        />
                    </div>
                )}
                {(path.mimeType === "video/mp4" || path.mimeType === "video/mpeg") && (
                    <div>
                        <video
                            src={`${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`}
                            className="w-full max-h-[25%] object-contain"
                            autoPlay={false}
                            controls
                        />
                    </div>
                )}
                {(path.mimeType == "audio/mpeg" || path.mimeType == "audio/wav" || path.mimeType == "audio/ogg" || path.mimeType == "audio/vorbis" || path.mimeType == "audio/mp4") && (
                    <div>
                        <audio
                            src={`${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`}
                            className="w-full"
                            autoPlay={false}
                            controls
                        />
                    </div>
                )}
                
                <div className="mt-4">
                    <DriveAccessList 
                        path={path}
                        acl={path.acl}
                    />
                </div>
            </div>
        </div>
    );
}
