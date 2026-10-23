import { getDriveItemUrl, getDriveShareUrl, openMailComposeWith } from '@workspace/lib/api';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { useIsSharedWithMe } from '@workspace/lib/drive';
import { useMailEnabled } from '@workspace/lib/public';
import {
    type DrivePath,
    EXPORT_FORMAT_LABELS,
    type ExportFormat,
    exportFormatsFor,
    isOpenable,
} from '@workspace/lib/types';
import {
    DropdownMenuItem,
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
    ExternalLink,
    FileDown,
    FolderInput,
    Link,
    Mail,
    Pencil,
    Trash2,
    UserRoundPlus,
} from 'lucide-react';
import { MenuSections } from '../context-menu/menu-sections';
import { FileActionMenuItems } from '../file-actions/file-action-menu-items';
import type { FileActionRunner } from '../file-actions/use-file-action-runner';
import { useWatchToggle } from '../layout/toolbar/watch-toggle-button';

// Drive keeps its own "Copy to…" row, so the registry's save-to-drive would say the same thing twice.

type DriveItemMenuItemsProps = {
    item: DrivePath;
    // Built by the host on subjectFromPath(item) — the rows it draws come from the registry.
    runner: FileActionRunner;
    // App-specific override for the "Open in new tab" URL. Defaults to the
    // canonical getDriveItemUrl. The drive-table accepts a getItemHref prop;
    // other callers can omit and inherit the default.
    href?: string;
    onClose?: () => void;
    onItemOpen?: (item: DrivePath) => void;
    onExport?: (item: DrivePath, format: ExportFormat) => void;
    onRename?: (item: DrivePath) => void;
    onMoveTo?: (items: DrivePath[]) => void;
    onCopyTo?: (items: DrivePath[]) => void;
    onDuplicate?: (items: DrivePath[]) => void;
    onShareClick?: (item: DrivePath) => void;
    onEmailCollaborators?: (item: DrivePath) => void;
    onDelete?: (items: DrivePath[]) => void;
    allowDelete?: boolean;
};

// A multi-select's rows live in drive-item-context-menu.tsx. Caller wraps with ContextMenuAnchor or DropdownMenuContent.
export function DriveItemMenuItems({
    item,
    runner,
    href: hrefOverride,
    onClose,
    onItemOpen,
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
    const canOpen = isOpenable(item);
    const mailEnabled = useMailEnabled();
    // The server leaves a direct share instead of trashing it, so the row says what DriveDeleteItem's dialog says.
    const isSharedWithMe = useIsSharedWithMe();
    // Which formats a type offers is the registry's answer, so this menu and the editors' File menu
    // draw the same rows and the export route gates on the same list.
    const exportFormats = exportFormatsFor(item.type);
    const accessible = !!item.acl?.length || item.visibility !== 'private';

    const { direct, label, isPending, toggle } = useWatchToggle(item.ownerId, item.mountId, item.id);

    const run = (fn: () => void) => () => {
        fn();
        onClose?.();
    };

    return (
        <MenuSections
            open={
                <>
                    {canOpen && onItemOpen && (
                        <DropdownMenuItem onClick={run(() => onItemOpen(item))}>
                            <ArrowRight className="h-4 w-4" />
                            Open
                        </DropdownMenuItem>
                    )}
                    {href && (
                        <DropdownMenuItem onClick={run(() => window.open(href, '_blank', 'noopener,noreferrer'))}>
                            <ExternalLink className="h-4 w-4" />
                            Open in new tab
                        </DropdownMenuItem>
                    )}
                    <FileActionMenuItems runner={runner} group="open" />
                </>
            }
            create={
                (onRename || onDuplicate) && (
                    <>
                        {onRename && (
                            <DropdownMenuItem onClick={run(() => onRename(item))}>
                                <Pencil className="h-4 w-4" />
                                Rename
                            </DropdownMenuItem>
                        )}
                        {onDuplicate && (
                            <DropdownMenuItem onClick={run(() => onDuplicate([item]))}>
                                <CopyPlus className="h-4 w-4" />
                                Duplicate
                            </DropdownMenuItem>
                        )}
                    </>
                )
            }
            organize={
                (onMoveTo || onCopyTo) && (
                    <>
                        {onMoveTo && (
                            <DropdownMenuItem onClick={run(() => onMoveTo([item]))}>
                                <FolderInput className="h-4 w-4" />
                                Move to…
                            </DropdownMenuItem>
                        )}
                        {onCopyTo && (
                            <DropdownMenuItem onClick={run(() => onCopyTo([item]))}>
                                <Copy className="h-4 w-4" />
                                Copy to…
                            </DropdownMenuItem>
                        )}
                    </>
                )
            }
            convert={<FileActionMenuItems runner={runner} group="convert" />}
            output={
                <>
                    {exportFormats.length > 0 && onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <FileDown className="h-4 w-4" />
                                Download
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {exportFormats.map((format) => (
                                    <DropdownMenuItem key={format} onClick={run(() => onExport(item, format))}>
                                        {EXPORT_FORMAT_LABELS[format]}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    <FileActionMenuItems runner={runner} group="output" />
                </>
            }
            collaborate={
                <>
                    {onShareClick && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <UserRoundPlus className="h-4 w-4" />
                                Share
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                <DropdownMenuItem onClick={run(() => onShareClick(item))}>
                                    <UserRoundPlus className="h-4 w-4" />
                                    Share
                                </DropdownMenuItem>
                                {onEmailCollaborators && accessible && (
                                    <DropdownMenuItem onClick={run(() => onEmailCollaborators(item))}>
                                        <Mail className="h-4 w-4" />
                                        Email collaborators
                                    </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                    onClick={run(() =>
                                        copyToClipboard(getDriveShareUrl(item), 'Link copied to clipboard'),
                                    )}
                                >
                                    <Link className="h-4 w-4" />
                                    Copy link
                                </DropdownMenuItem>
                                {mailEnabled && (
                                    <DropdownMenuItem onClick={run(() => openMailComposeWith({ attachments: [item] }))}>
                                        <Mail className="h-4 w-4" />
                                        Mail to…
                                    </DropdownMenuItem>
                                )}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    <DropdownMenuItem disabled={isPending} onClick={run(toggle)}>
                        {direct ? <BellRing className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
                        {label}
                    </DropdownMenuItem>
                </>
            }
            destructive={
                allowDelete &&
                onDelete && (
                    <DropdownMenuItem variant="destructive" onClick={run(() => onDelete([item]))}>
                        <Trash2 className="h-4 w-4" />
                        {isSharedWithMe(item) ? 'Remove shared item' : 'Move to trash'}
                    </DropdownMenuItem>
                )
            }
        />
    );
}
