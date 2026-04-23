import { formatForDisplay } from '@tanstack/react-hotkeys';
import { useNavigate } from '@tanstack/react-router';
import { openDocument } from '@workspace/lib/api';
import { fetchRevisionState, useCollabRevisions } from '@workspace/lib/collab';
import { formatDateTime } from '@workspace/lib/date';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
} from '@workspace/lib/types/drive';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { ConfirmDialog } from '@workspace/ui/components/layout/delete/confirm-dialog';
import {
    Download,
    FileText,
    Folder,
    History,
    type LucideIcon,
    Mail,
    Pencil,
    Trash2,
    Upload,
    UserRoundPlus,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { DriveCreateEigenDoc } from '../drive/drive-create-eigendoc';
import { DriveDeleteItem } from '../drive/drive-delete-item';
import { DriveEmailCollaborators } from '../drive/drive-email-collaborators';
import { DriveFilePicker } from '../drive/drive-file-picker';
import { DriveRenameItem } from '../drive/drive-rename-item';

const OPEN_LABELS: Record<EigenDocType, { mime: string; title: string }> = {
    doc: { mime: DRIVE_MIME_DOC, title: 'Open doc' },
    stickies: { mime: DRIVE_MIME_STICKIES, title: 'Open stickies' },
    slides: { mime: DRIVE_MIME_SLIDES, title: 'Open slides' },
    sheets: { mime: DRIVE_MIME_SHEETS, title: 'Open sheet' },
    chat: { mime: DRIVE_MIME_CHAT, title: 'Open chat' },
};

const DOWNLOAD_LABELS: Record<string, string> = {
    docx: 'Microsoft Word (.docx)',
    pdf: 'PDF (.pdf)',
    html: 'Web Page (.html)',
    xlsx: 'Microsoft Excel (.xlsx)',
    csv: 'Comma Separated Values (.csv)',
};

export function formatDownloadLabel(format: string): string {
    return DOWNLOAD_LABELS[format] ?? `${format.toUpperCase()} (.${format})`;
}

type FileMenuProps = {
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onRestore?: (state: Uint8Array) => void;
    onImport?: () => void;
    importLabel?: string;
    onExport?: (format: string) => void;
    exportFormats?: string[];
    createLabel: string;
    createIcon?: LucideIcon;
    createType: EigenDocType;
    children?: ReactNode;
};

export function FileMenu({
    path,
    canWrite,
    onAccessDialogOpen,
    onRestore,
    onImport,
    importLabel,
    onExport,
    exportFormats,
    createLabel,
    createIcon: CreateIcon = FileText,
    createType,
    children,
}: FileMenuProps) {
    const [createOpen, setCreateOpen] = useState(false);
    const [openPickerOpen, setOpenPickerOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [deleteOpen, setDeleteOpen] = useState(false);
    const [emailOpen, setEmailOpen] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [confirmOpen, setConfirmOpen] = useState(false);
    const [pendingRevisionId, setPendingRevisionId] = useState<number | null>(null);
    const openConfig = OPEN_LABELS[createType];
    const { data: revisions } = useCollabRevisions(path.ownerId, path.mountId, path.id, menuOpen && !!onRestore);
    const navigate = useNavigate();

    const handleRevisionClick = (revisionId: number) => {
        setPendingRevisionId(revisionId);
        setMenuOpen(false);
        setConfirmOpen(true);
    };

    const handleConfirmRestore = async () => {
        if (pendingRevisionId === null || !onRestore) return;
        const state = await fetchRevisionState(path.ownerId, path.mountId, path.id, pendingRevisionId);
        if (!state) return;
        onRestore(state);
        setConfirmOpen(false);
        setPendingRevisionId(null);
    };

    return (
        <>
            <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                    <Button variant="ghost">File</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                    {/* Section 1: Create & Open */}
                    <DropdownMenuItem onClick={() => setCreateOpen(true)}>
                        <CreateIcon className="h-4 w-4 mr-2" /> {createLabel}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setOpenPickerOpen(true)}>
                        <Folder className="h-4 w-4 mr-2" /> Open…
                    </DropdownMenuItem>
                    {canWrite && onImport && (
                        <DropdownMenuItem onClick={onImport}>
                            <Upload className="h-4 w-4 mr-2" /> {importLabel ?? 'Import…'}
                        </DropdownMenuItem>
                    )}

                    {/* Section 2: Export & Rename */}
                    <DropdownMenuSeparator />
                    {onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Download className="h-4 w-4 mr-2" /> Download
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {(exportFormats ?? ['docx', 'pdf', 'html']).map((format) => (
                                    <DropdownMenuItem key={format} onClick={() => onExport(format)}>
                                        {formatDownloadLabel(format)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                        <Pencil className="h-4 w-4 mr-2" /> Rename
                    </DropdownMenuItem>

                    {/* Section 3: Share */}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={onAccessDialogOpen}>
                        <UserRoundPlus className="h-4 w-4 mr-2" /> Share
                    </DropdownMenuItem>
                    {canWrite && (
                        <DropdownMenuItem onClick={() => setEmailOpen(true)}>
                            <Mail className="h-4 w-4 mr-2" /> Email collaborators
                        </DropdownMenuItem>
                    )}

                    {/* Section 4: Version history & Print */}
                    {(onRestore || children) && <DropdownMenuSeparator />}
                    {onRestore && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <History className="h-4 w-4 mr-2" /> Version history
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="max-h-64 overflow-y-auto min-w-[240px]">
                                {revisions && revisions.length > 0 ? (
                                    revisions.map((rev) => (
                                        <DropdownMenuItem
                                            key={rev.id}
                                            className="flex items-center justify-between gap-4"
                                            onClick={() => handleRevisionClick(rev.id)}
                                        >
                                            <span>
                                                {rev.createdAt
                                                    ? formatDateTime(new Date(rev.createdAt))
                                                    : `Revision #${rev.id}`}
                                            </span>
                                            <span className="text-xs text-muted-foreground">Restore</span>
                                        </DropdownMenuItem>
                                    ))
                                ) : (
                                    <DropdownMenuItem disabled>No revisions yet</DropdownMenuItem>
                                )}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    {children}

                    {/* Section 5: Move to bin */}
                    {canWrite && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                                <Trash2 className="h-4 w-4 mr-2" /> Move to bin
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>

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
                mimeFilter={[openConfig.mime]}
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
                    if (actionType === 'delete') navigate({ to: `/` });
                }}
            />
            {onRestore && (
                <ConfirmDialog
                    open={confirmOpen}
                    onOpenChange={(value) => {
                        setConfirmOpen(value);
                        if (!value) setPendingRevisionId(null);
                    }}
                    title="Restore revision"
                    description={`This will replace the current document content with the selected revision for all collaborators. Use ${formatForDisplay('Mod+Z')} to undo after restoring.`}
                    confirmText="Restore"
                    onConfirm={handleConfirmRestore}
                />
            )}
        </>
    );
}
