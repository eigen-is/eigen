import {getDriveDownloadUrl, getDriveThumbnailUrl} from "@workspace/lib/api";
import {ArrowRight, Download, MoreVertical, Pencil, Trash2, UserRoundPlus, X} from "lucide-react";
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
import {type DrivePath} from "@workspace/lib/types/drive";
import {formatFileSize} from "@workspace/ui/lib/formatFileSize";
import {Table, TableBody, TableCell, TableRow} from "@workspace/ui/components/table";
import {useLayout} from "../app/layout-context.tsx";

type DriveDetailToolbarProps = {
    path: DrivePath;
    onClose?: () => void;
    onDelete?: (path: DrivePath) => void;
    onShareClick?: (path: DrivePath) => void;
    onDownload?: (path: DrivePath) => void;
    onItemOpen?: (path: DrivePath) => void;
    onRename?: (path: DrivePath) => void;
    allowDelete?: boolean;
}

export function DriveDetailToolbar({
                                       path,
                                       onClose,
                                       onDelete,
                                       onShareClick,
                                       onDownload,
                                       onItemOpen,
                                       onRename,
                                       allowDelete,
                                   }: DriveDetailToolbarProps) {
    const {isMobile} = useLayout();

    return (
        <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-1">
                {!isMobile && onClose && (
                    <TooltipButton onClick={onClose} tooltipText="Close" icon={X}/>
                )}
            </div>
            <div className="flex items-center gap-1">
                {onDelete && (
                    <TooltipButton
                        icon={Trash2}
                        tooltipText="Delete"
                        onClick={() => onDelete(path)}
                    />
                )}
                <div className="h-6 w-[1px] bg-border mx-1"/>
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
                        <DropdownMenuItem onClick={() => onRename?.(path)} className="flex items-center">
                            <Pencil className="h-4 w-4 mr-2"/>
                            Rename
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
    );
}

type DriveDetailProps = {
    path: DrivePath | null;
    onDelete?: (path: DrivePath) => void;
    onShareClick?: (path: DrivePath) => void;
    onDownload?: (path: DrivePath) => void;
    onItemOpen?: (path: DrivePath) => void;
    onRename?: (path: DrivePath) => void;
    allowDelete?: boolean;
}

export function DriveDetail({
                                path,
                                onShareClick,
                                onItemOpen,
                            }: DriveDetailProps) {

    if (!path) {
        return (
            <div className="flex h-full items-center justify-center">
                <EigenLoader/>
            </div>
        );
    }

    const fullPath = getDriveDownloadUrl(path.ownerId, path.mountId, path.id);
    const thumbnailPath = getDriveThumbnailUrl(path.ownerId, path.mountId, path.thumbnail || '');

    return (
        <div className="flex flex-col h-full bg-white">
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
                            style={path.details?.width && path.details?.height ? {aspectRatio: path.details.width / path.details.height} : undefined}
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
                            style={path.details?.width && path.details?.height ? {aspectRatio: path.details.width / path.details.height} : undefined}
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

                {path.details && (path.details.width || path.details.height || path.details.duration || path.details.pageCount) && (
                    <Table className="mt-4">
                        <TableBody>
                            {path.details.width && path.details.height && (
                                <TableRow>
                                    <TableCell className="font-medium px-0 w-20">Dimensions</TableCell>
                                    <TableCell className="px">{path.details.width} × {path.details.height}</TableCell>
                                </TableRow>
                            )}
                            {path.details.duration && (
                                <TableRow>
                                    <TableCell className="font-medium px-0 w-20">Duration</TableCell>
                                    <TableCell
                                        className="px">{Math.floor(path.details.duration / 60)}:{String(Math.floor(path.details.duration % 60)).padStart(2, '0')}</TableCell>
                                </TableRow>
                            )}
                            {path.details.pageCount && (
                                <TableRow>
                                    <TableCell className="font-medium px-0 w-20">Pages</TableCell>
                                    <TableCell className="px">{path.details.pageCount}</TableCell>
                                </TableRow>
                            )}
                            {Object.entries(path.details)
                                .filter(([key]) => !['width', 'height', 'duration', 'pageCount'].includes(key))
                                .map(([key, value]) => (
                                    <TableRow key={key}>
                                        <TableCell className="font-medium px-0 w-20 capitalize">{key}</TableCell>
                                        <TableCell className="px truncate">{String(value)}</TableCell>
                                    </TableRow>
                                ))
                            }
                        </TableBody>
                    </Table>
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
