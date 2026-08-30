import { getDriveItemUrl, getDriveShareUrl, openMailComposeWith } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { type DrivePath, isFolderType, isOpenable } from '@workspace/lib/types';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {
    ArrowRight,
    Bell,
    BellRing,
    Copy,
    CopyPlus,
    Download,
    ExternalLink,
    Eye,
    FileDown,
    FileText,
    FolderInput,
    Link,
    Mail,
    Pencil,
    Sheet,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import { formatDownloadLabel } from '../layout/toolbar/file-menu';
import { useWatchToggle } from '../layout/toolbar/watch-toggle-button';

type DriveItemMenuItemsProps = {
    item: DrivePath;
    // App-specific override for the "Open in new tab" URL. Defaults to the
    // canonical getDriveItemUrl. The drive-table accepts a getItemHref prop;
    // other callers can omit and inherit the default.
    href?: string;
    onClose?: () => void;
    onItemOpen?: (item: DrivePath) => void;
    onQuickLook?: (item: DrivePath) => void;
    onDownload?: (item: DrivePath) => void;
    onConvert?: (item: DrivePath, target: 'eigensheets' | 'eigendoc') => void;
    onExport?: (item: DrivePath, format: string) => void;
    onRename?: (item: DrivePath) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    allowDelete?: boolean;
};

// Multi-select "Move N items to trash" lives in drive-table.tsx — selection
// model is table-specific. Caller wraps with ContextMenuAnchor or DropdownMenuContent.
export function DriveItemMenuItems({
    item,
    href: hrefOverride,
    onClose,
    onItemOpen,
    onQuickLook,
    onDownload,
    onConvert,
    onExport,
    onRename,
    onMoveTo,
    onCopyTo,
    onDuplicate,
    onShareClick,
    onEmailCollaborators,
    onDelete,
    allowDelete,
}: DriveItemMenuItemsProps) {
    const href = hrefOverride ?? getDriveItemUrl(item);
    const nameLower = item.name.toLowerCase();
    const canOpen = isOpenable(item);
    const canQuickLook = !isFolderType(item.type);
    const canDownloadFile = item.type === 'file' && !!onDownload;
    const canConvertXlsx = item.type === 'file' && nameLower.endsWith('.xlsx') && !!onConvert;
    const canConvertDocx = item.type === 'file' && nameLower.endsWith('.docx') && !!onConvert;
    const canExport =
        (item.type === 'doc' || item.type === 'slides' || item.type === 'sheets' || item.type === 'vector') &&
        !!onExport;
    const accessible = !!item.acl?.length || item.visibility !== 'private';

    const { direct, label, isPending, toggle } = useWatchToggle(item.ownerId, item.mountId, item.id);

    const run = (fn: () => void) => () => {
        fn();
        onClose?.();
    };

    return (
        <>
            {canOpen && onItemOpen && (
                <DropdownMenuItem onClick={run(() => onItemOpen(item))} className="flex items-center">
                    <ArrowRight className="h-4 w-4 mr-2" />
                    Open
                </DropdownMenuItem>
            )}
            {href && (
                <DropdownMenuItem onClick={run(() => window.open(href, '_blank'))} className="flex items-center">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Open in new tab
                </DropdownMenuItem>
            )}
            {canQuickLook && onQuickLook && (
                <DropdownMenuItem onClick={run(() => onQuickLook(item))} className="flex items-center">
                    <Eye className="h-4 w-4 mr-2" />
                    Quick preview
                </DropdownMenuItem>
            )}

            {(canDownloadFile ||
                canConvertXlsx ||
                canConvertDocx ||
                canExport ||
                !!onRename ||
                !!onMoveTo ||
                !!onCopyTo ||
                !!onDuplicate) && <DropdownMenuSeparator />}
            {canDownloadFile && (
                <DropdownMenuItem onClick={run(() => onDownload(item))} className="flex items-center">
                    <Download className="h-4 w-4 mr-2" />
                    Download
                </DropdownMenuItem>
            )}
            {canConvertXlsx && onConvert && (
                <DropdownMenuItem onClick={run(() => onConvert(item, 'eigensheets'))} className="flex items-center">
                    <Sheet className="h-4 w-4 mr-2" />
                    Convert to Sheet
                </DropdownMenuItem>
            )}
            {canConvertDocx && onConvert && (
                <DropdownMenuItem onClick={run(() => onConvert(item, 'eigendoc'))} className="flex items-center">
                    <FileText className="h-4 w-4 mr-2" />
                    Convert to Document
                </DropdownMenuItem>
            )}
            {canExport && onExport && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                        <FileDown className="h-4 w-4 mr-2" />
                        Download
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {(item.type === 'doc'
                            ? ['docx', 'pdf', 'html']
                            : item.type === 'sheets'
                              ? ['xlsx', 'pdf', 'html']
                              : item.type === 'vector'
                                ? ['svg', 'pdf']
                                : ['pdf', 'html']
                        ).map((format) => (
                            <DropdownMenuItem key={format} onClick={run(() => onExport(item, format))}>
                                {formatDownloadLabel(format)}
                            </DropdownMenuItem>
                        ))}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            {onRename && (
                <DropdownMenuItem onClick={run(() => onRename(item))} className="flex items-center">
                    <Pencil className="h-4 w-4 mr-2" />
                    Rename
                </DropdownMenuItem>
            )}
            {onMoveTo && (
                <DropdownMenuItem onClick={run(() => onMoveTo([item]))} className="flex items-center">
                    <FolderInput className="h-4 w-4 mr-2" />
                    Move to…
                </DropdownMenuItem>
            )}
            {onCopyTo && (
                <DropdownMenuItem onClick={run(() => onCopyTo([item]))} className="flex items-center">
                    <Copy className="h-4 w-4 mr-2" />
                    Copy to…
                </DropdownMenuItem>
            )}
            {onDuplicate && (
                <DropdownMenuItem onClick={run(() => onDuplicate([item]))} className="flex items-center">
                    <CopyPlus className="h-4 w-4 mr-2" />
                    Duplicate
                </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={isPending} onClick={run(toggle)} className="flex items-center">
                {direct ? <BellRing className="h-4 w-4 mr-2" /> : <Bell className="h-4 w-4 mr-2" />}
                {label}
            </DropdownMenuItem>

            {onShareClick && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <UserRoundPlus className="h-4 w-4 mr-2" />
                            Share
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            <DropdownMenuItem onClick={run(() => onShareClick(item))}>
                                <UserRoundPlus className="h-4 w-4 mr-2" />
                                Share
                            </DropdownMenuItem>
                            {onEmailCollaborators && accessible && (
                                <DropdownMenuItem onClick={run(() => onEmailCollaborators(item))}>
                                    <Mail className="h-4 w-4 mr-2" />
                                    Email collaborators
                                </DropdownMenuItem>
                            )}
                            <DropdownMenuItem
                                onClick={run(() => copyToClipboard(getDriveShareUrl(item), 'Link copied to clipboard'))}
                            >
                                <Link className="h-4 w-4 mr-2" />
                                Copy link
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={run(() => openMailComposeWith({ attachments: [item] }))}>
                                <Mail className="h-4 w-4 mr-2" />
                                Mail to…
                            </DropdownMenuItem>
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                </>
            )}

            {allowDelete && onDelete && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={run(() => onDelete([item]))} className="flex items-center">
                        <Trash2 className="h-4 w-4 mr-2" />
                        Move to trash
                    </DropdownMenuItem>
                </>
            )}
        </>
    );
}
