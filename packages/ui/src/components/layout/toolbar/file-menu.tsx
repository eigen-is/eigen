// The File menu on the toolbar of an open Eigen document, such as a doc, a sheet or a board. It
// creates, opens, copies, renames, downloads, shares and trashes the document, and opens its version history.
// Open recent lists the newest files of the same kind from the viewer's recent list, which Drive's Recent page reads.
// Its Drive rows, such as Rename and Move to trash, come from the Drive action catalog with Drive's
// gates. It also hands the document and those rows to the command palette, so both offer the same ones. A visitor
// without a login keeps only the editor's own rows, such as Print.

import { useNavigate } from '@tanstack/react-router';
import { getDriveShareUrl, openDocument, openMailComposeWith } from '@workspace/lib/api';
import { useAuth, useIsGuest } from '@workspace/lib/auth';
import { copyToClipboard } from '@workspace/lib/clipboard';
import { usePaletteSelection } from '@workspace/lib/command-palette';
import { useDriveActionsFor, useMakeCopy, useRecentPaths } from '@workspace/lib/drive';
import type { DrivePath, EigenDocType, ExportFormat } from '@workspace/lib/types/drive';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_MIME_VECTOR,
    exportFormatsFor,
    stripEigenExtension,
} from '@workspace/lib/types/drive';
import type { DriveActionId } from '@workspace/lib/types/drive-actions';
import { EXPORT_FORMAT_LABELS } from '@workspace/lib/types/drive-convert';
import type { Snapshot } from '@workspace/lib/types/versioning';
import {
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useDialogValue } from '@workspace/ui/hooks/use-dialog-value';
import type { LucideIcon } from 'lucide-react';
import { Clock, CopyPlus, Download, FileText, Folder, Upload } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { DriveActionMenuItem } from '../../drive/drive-action-menu-item';
import { browseCapabilities } from '../../drive/drive-capabilities';
import { DriveCreateEigenDoc } from '../../drive/drive-create-eigendoc';
import { DriveDeleteItem } from '../../drive/drive-delete-item';
import { DriveEmailCollaborators } from '../../drive/drive-email-collaborators';
import { DriveFilePicker } from '../../drive/drive-file-picker';
import { DriveRenameItem } from '../../drive/drive-rename-item';
import { getFileIcon } from '../../drive/file-presentation';
import { AppBarMenu } from './app-bar-menu';
import { DeleteHistoryDialog, RestoreVersionDialog, VersionHistoryMenu } from './version-history-menu';

const OPEN_LABELS: Record<EigenDocType, { mime: string; title: string }> = {
    doc: { mime: DRIVE_MIME_DOC, title: 'Open doc' },
    stickies: { mime: DRIVE_MIME_STICKIES, title: 'Open stickies' },
    slides: { mime: DRIVE_MIME_SLIDES, title: 'Open slides' },
    sheets: { mime: DRIVE_MIME_SHEETS, title: 'Open sheet' },
    chat: { mime: DRIVE_MIME_CHAT, title: 'Open chat' },
    vector: { mime: DRIVE_MIME_VECTOR, title: 'Open vector' },
};

const RECENT_LIMIT = 8;

type FileMenuProps = {
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onImport?: () => void;
    onExport?: (format: ExportFormat) => void;
    // A drawing's SVG, which the open editor writes rather than the export route.
    onDownloadSvg?: () => void;
    createLabel: string;
    createIcon?: LucideIcon;
    createType: EigenDocType;
    children?: ReactNode;
    // An editor that takes focus back once the menu closes passes its keep-focus handler.
    onCloseAutoFocus?: (event: Event) => void;
};

export function FileMenu({
    path,
    canWrite,
    onAccessDialogOpen,
    onImport,
    onExport,
    onDownloadSvg,
    createLabel,
    createIcon: CreateIcon = FileText,
    createType,
    children,
    onCloseAutoFocus,
}: FileMenuProps) {
    const { user } = useAuth();
    const [createOpen, setCreateOpen] = useState(false);
    const [openPickerOpen, setOpenPickerOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [emailOpen, setEmailOpen] = useState(false);
    // The version dialogs' state lives here, because the menu unmounts VersionHistoryMenu when it closes.
    const restoreDialog = useDialogValue<Snapshot>();
    const deleteHistoryDialog = useDialogValue<number>();
    const openConfig = OPEN_LABELS[createType];
    const downloadFormats = exportFormatsFor(createType);
    const canExport = !!onExport && downloadFormats.length > 0;
    const canDownload = canExport || !!onDownloadSvg;
    const navigate = useNavigate();
    // The document stands where Drive's folder browser stands on a folder: the viewer's write access
    // to it gates the writes, and an item shared with the viewer is removed rather than trashed.
    const actionsFor = useDriveActionsFor(browseCapabilities(canWrite));
    const { mutate: makeCopy } = useMakeCopy();

    // The Drive rows this menu can run, through the dialogs it owns. Copy link and Mail to go to the palette
    // only, and so does Download as, which the menu draws as its own Download submenu.
    const runs: Partial<Record<DriveActionId, (format?: ExportFormat) => void>> = {
        rename: () => setRenameOpen(true),
        'download-as':
            onExport &&
            ((format) => {
                if (format) onExport(format);
            }),
        share: onAccessDialogOpen,
        'email-collaborators': () => setEmailOpen(true),
        'copy-link': () => copyToClipboard(getDriveShareUrl(path), 'Link copied to clipboard'),
        'mail-to': () => openMailComposeWith({ attachments: [path] }),
        trash: () => setDeleteOpen(true),
        'remove-shared': () => setDeleteOpen(true),
    };
    const actions = actionsFor([path]);
    const rows = actions.flatMap((action) => {
        const run = runs[action.id];
        return run ? [{ action, run }] : [];
    });
    // Every document toolbar mounts one, so this publishes the open document in every editor app.
    usePaletteSelection([path], rows);

    const rowFor = (id: DriveActionId) => {
        const row = rows.find(({ action }) => action.id === id);
        return row && <DriveActionMenuItem action={row.action} count={1} onClick={() => row.run()} />;
    };
    if (!user) {
        return children ? (
            <AppBarMenu label="File" onCloseAutoFocus={onCloseAutoFocus}>
                {children}
            </AppBarMenu>
        ) : null;
    }

    const remove = rowFor('trash') ?? rowFor('remove-shared');
    // A copy lands beside the original, so it is offered where Drive offers Duplicate.
    const canCopy = actions.some((action) => action.id === 'duplicate');

    return (
        <>
            <AppBarMenu label="File" onCloseAutoFocus={onCloseAutoFocus}>
                <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                    <CreateIcon className="h-4 w-4" /> {createLabel}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setOpenPickerOpen(true)}>
                    <Folder className="h-4 w-4" /> Open…
                </DropdownMenuItem>
                <OpenRecentMenu path={path} mime={openConfig.mime} />
                {canWrite && onImport && (
                    <DropdownMenuItem onClick={onImport}>
                        <Upload className="h-4 w-4" /> Import…
                    </DropdownMenuItem>
                )}
                <DropdownMenuItem disabled={!canCopy} onClick={() => makeCopy(path)}>
                    <CopyPlus className="h-4 w-4" /> Make a copy
                </DropdownMenuItem>

                <DropdownMenuSeparator />
                {canDownload && (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                            <Download className="h-4 w-4" /> Download
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                            {onDownloadSvg && (
                                <DropdownMenuItem onClick={onDownloadSvg}>SVG image (.svg)</DropdownMenuItem>
                            )}
                            {onExport &&
                                downloadFormats.map((format) => (
                                    <DropdownMenuItem key={format} onClick={() => onExport(format)}>
                                        {EXPORT_FORMAT_LABELS[format]}
                                    </DropdownMenuItem>
                                ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
                {rowFor('rename')}

                <DropdownMenuSeparator />
                {rowFor('share')}
                {rowFor('email-collaborators')}

                <DropdownMenuSeparator />
                {canWrite && (
                    <VersionHistoryMenu
                        path={path}
                        onRequestRestore={restoreDialog.openDialog}
                        onRequestDeleteHistory={deleteHistoryDialog.openDialog}
                    />
                )}
                {children}

                {remove && (
                    <>
                        <DropdownMenuSeparator />
                        {remove}
                    </>
                )}
            </AppBarMenu>

            <DriveCreateEigenDoc
                open={createOpen}
                onOpenChange={setCreateOpen}
                type={createType}
                defaultOwnerId={path.ownerId}
                defaultFolderId={path.parentId ?? undefined}
                defaultMountId={path.mountId}
            />
            <DriveFilePicker
                open={openPickerOpen}
                onOpenChange={setOpenPickerOpen}
                title={openConfig.title}
                canPick={(item) => item.mimeType === openConfig.mime}
                onSelect={(paths) => {
                    const picked = paths[0];
                    if (picked) openDocument(picked);
                }}
            />
            <DriveRenameItem path={path} open={renameOpen} onOpenChange={setRenameOpen} />
            <DriveEmailCollaborators path={path} open={emailOpen} onOpenChange={setEmailOpen} />
            <DriveDeleteItem
                paths={[path]}
                open={deleteOpen}
                onOpenChange={setDeleteOpen}
                onAfterAction={(actionType) => {
                    if (actionType === 'delete') navigate({ to: '/' });
                }}
            />
            {restoreDialog.value && (
                <RestoreVersionDialog
                    path={path}
                    snapshot={restoreDialog.value}
                    open={restoreDialog.open}
                    onOpenChange={restoreDialog.setOpen}
                />
            )}
            {deleteHistoryDialog.value !== undefined && (
                <DeleteHistoryDialog
                    path={path}
                    size={deleteHistoryDialog.value}
                    open={deleteHistoryDialog.open}
                    onOpenChange={deleteHistoryDialog.setOpen}
                />
            )}
        </>
    );
}

// It mounts with the menu, so the list is loading before the pointer reaches the row. A guest has no recent list.
function OpenRecentMenu({ path, mime }: { path: DrivePath; mime: string }) {
    const isGuest = useIsGuest();
    const { data = [] } = useRecentPaths(true);
    if (isGuest) return null;
    const recent = data.filter((item) => item.mimeType === mime && item.id !== path.id).slice(0, RECENT_LIMIT);

    return (
        <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={recent.length === 0}>
                <Clock className="h-4 w-4" /> Open recent
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-w-72">
                {recent.map((item) => (
                    <DropdownMenuItem key={item.id} onSelect={() => openDocument(item)}>
                        {getFileIcon(item.mimeType, item.type, item.name, { className: 'h-4 w-4' })}
                        <span className="truncate">{stripEigenExtension(item.name)}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuSubContent>
        </DropdownMenuSub>
    );
}
