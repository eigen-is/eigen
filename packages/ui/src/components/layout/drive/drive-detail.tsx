import {cn} from "@workspace/ui/lib/utils";
import {ArrowLeft, ArrowRight, Download, MoreVertical, Trash2, UserRoundPlus, X} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@workspace/ui/components/dropdown-menu";
import {Button} from "@workspace/ui/components/button";
import {EigenLoader, TooltipButton} from "@workspace/ui";
import {DriveAccessList} from "@workspace/ui/components/layout/drive";
import {type DrivePath} from "@apps/api-server/types/drive";
import {formatFileSize} from "@workspace/ui/lib/formatFileSize";
import {Table, TableBody, TableCell, TableRow} from "@workspace/ui/components/table";

interface DriveDetailProps {
    path: any | null;
    isMobile?: boolean;
    className?: string;
    onBackClick?: () => void;
    onDelete: (path: any) => void;
    onShareClick?: (item: DrivePath) => void;
    onDownload?: (path: DrivePath) => void;
    onItemOpen?: (item: DrivePath) => void;
    allowDelete?: boolean;
}

export function DriveDetail({
                                path,
                                isMobile,
                                className,
                                onBackClick,
                                onDelete,
                                onShareClick,
                                onDownload,
                                onItemOpen,
                                allowDelete,
                                ...props
                            }: DriveDetailProps) {

    if (!path) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const fullPath = `${import.meta.env.VITE_API_HOST}/drive/download/${path.ownerId}/${path.id}`;
    const thumbnailPath = `${import.meta.env.VITE_API_HOST}/drive/thumb/${path.ownerId}/${path.thumbnail}`;

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

                    <div className="h-6 w-[1px] bg-border mx-1"></div>

                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8" title="More actions">
                                <MoreVertical className="h-4 w-4"/>
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent>
                            <DropdownMenuItem onClick={() => onItemOpen?.(path)} className="flex items-center">
                                <ArrowRight className="h-4 w-4 mr-2"/>
                                Open
                            </DropdownMenuItem>
                            {path.type === 'file' && (
                                <DropdownMenuItem onClick={() => onDownload?.(path)} className="flex items-center">
                                    <Download className="h-4 w-4 mr-2"/>
                                    Download
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => onShareClick?.(path)} className="flex items-center">
                                <UserRoundPlus className="h-4 w-4 mr-2"/>
                                Edit access
                            </DropdownMenuItem>
                            <DropdownMenuSeparator/>
                            {allowDelete && (
                                <DropdownMenuItem onClick={() => onDelete?.(path)} className="flex items-center">
                                    <Trash2 className="h-4 w-4 mr-2"/>
                                    Delete
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                </div>
            </div>

            <div className="p-4 flex-1 overflow-auto">
                <h2 className="text-xl font-medium mb-2 flex items-center">
                    <span className="truncate overflow-hidden min-w-0 flex-1">{path.name}</span>
                    {onItemOpen && path && path.type !== 'file' && (
                        <TooltipButton
                            onClick={() => onItemOpen(path)}
                            tooltipText="Open"
                            icon={ArrowRight}
                        />
                    )}
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
                            src={thumbnailPath}
                            alt={`Thumbnail for ${path.name}`}
                            className="max-w-full max-h-[25%] object-contain"
                        />
                    </div>
                )}
                {(path.mimeType === "video/mp4" || path.mimeType === "video/mpeg") && (
                    <div>
                        <video
                            src={fullPath}
                            className="w-full max-h-[25%] object-contain"
                            autoPlay={false}
                            controls
                        />
                    </div>
                )}
                {(path.mimeType == "audio/mpeg" || path.mimeType == "audio/wav" || path.mimeType == "audio/ogg" || path.mimeType == "audio/vorbis" || path.mimeType == "audio/mp4") && (
                    <div>
                        <audio
                            src={fullPath}
                            className="w-full"
                            autoPlay={false}
                            controls
                        />
                    </div>
                )}


                <div className="mt-4">
                    <DriveAccessList
                        path={path}
                        onShareClick={onShareClick}
                    />
                </div>
            </div>
        </div>
    );
}
