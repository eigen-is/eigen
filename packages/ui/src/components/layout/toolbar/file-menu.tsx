import { useNavigate } from '@tanstack/react-router';
import { openDocument } from '@workspace/lib/api';
import { usePaletteSelectionActions } from '@workspace/lib/command-palette';
import type { DrivePath, EigenDocType, ExportFormat } from '@workspace/lib/types/drive';
import {
    DRIVE_MIME_CHAT,
    DRIVE_MIME_DOC,
    DRIVE_MIME_SHEETS,
    DRIVE_MIME_SLIDES,
    DRIVE_MIME_STICKIES,
    DRIVE_MIME_VECTOR,
    exportFormatsFor,
} from '@workspace/lib/types/drive';
import type { Snapshot } from '@workspace/lib/types/versioning';
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
import { Download, FileText, Folder, type LucideIcon, Mail, Pencil, Trash2, Upload, UserRoundPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { DriveCreateEigenDoc } from '../../drive/drive-create-eigendoc';
import { DriveDeleteItem } from '../../drive/drive-delete-item';
import { DriveEmailCollaborators } from '../../drive/drive-email-collaborators';
import { DriveFilePicker } from '../../drive/drive-file-picker';
import { DriveRenameItem } from '../../drive/drive-rename-item';
import { RestoreVersionDialog, VersionHistoryMenu } from './version-history-menu';

const OPEN_LABELS: Record<EigenDocType, { mime: string; title: string }> = {
    doc: { mime: DRIVE_MIME_DOC, title: 'Open doc' },
    stickies: { mime: DRIVE_MIME_STICKIES, title: 'Open stickies' },
    slides: { mime: DRIVE_MIME_SLIDES, title: 'Open slide' },
    sheets: { mime: DRIVE_MIME_SHEETS, title: 'Open sheet' },
    chat: { mime: DRIVE_MIME_CHAT, title: 'Open chat' },
    vector: { mime: DRIVE_MIME_VECTOR, title: 'Open vector' },
};

const DOWNLOAD_LABELS: Record<ExportFormat, string> = {
    docx: 'Microsoft Word (.docx)',
    pdf: 'PDF (.pdf)',
    html: 'Web Page (.html)',
    xlsx: 'Microsoft Excel (.xlsx)',
    svg: 'SVG image (.svg)',
};

export function formatDownloadLabel(format: ExportFormat): string {
    return DOWNLOAD_LABELS[format];
}

type FileMenuProps = {
    path: DrivePath;
    canWrite: boolean;
    onAccessDialogOpen: () => void;
    onImport?: () => void;
    importLabel?: string;
    onExport?: (format: ExportFormat) => void;
    createLabel: string;
    createIcon?: LucideIcon;
    createType: EigenDocType;
    children?: ReactNode;
};

export function FileMenu({
    path,
    canWrite,
    onAccessDialogOpen,
    onImport,
    importLabel,
    onExport,
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
    // Lifted out of VersionHistoryMenu so the dialog survives the dropdown's unmount-on-close.
    const [pendingSnapshot, setPendingSnapshot] = useState<Snapshot | null>(null);
    const openConfig = OPEN_LABELS[createType];
    const downloadFormats = exportFormatsFor(createType);
    const canDownload = !!onExport && downloadFormats.length > 0;
    const navigate = useNavigate();

    // Mounted by every eigendoc toolbar, so one publish gives ⌘K the open doc's actions
    // across all four apps. The doc is published as the selection upstream
    // (useEigenDocEditorRoute); usePaletteSelectionActions stabilises these handlers.
    usePaletteSelectionActions({
        onShare: onAccessDialogOpen,
        onRename: canWrite ? () => setRenameOpen(true) : undefined,
        onEmailCollaborators: canWrite ? () => setEmailOpen(true) : undefined,
        onDelete: canWrite ? () => setDeleteOpen(true) : undefined,
    });

    return (
        <>
            <DropdownMenu>
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
                    {(canDownload || canWrite) && <DropdownMenuSeparator />}
                    {canDownload && onExport && (
                        <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                                <Download className="h-4 w-4 mr-2" /> Download
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent>
                                {downloadFormats.map((format) => (
                                    <DropdownMenuItem key={format} onClick={() => onExport(format)}>
                                        {formatDownloadLabel(format)}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuSubContent>
                        </DropdownMenuSub>
                    )}
                    {canWrite && (
                        <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                            <Pencil className="h-4 w-4 mr-2" /> Rename
                        </DropdownMenuItem>
                    )}

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
                    {(canWrite || children) && <DropdownMenuSeparator />}
                    {canWrite && <VersionHistoryMenu path={path} onRequestRestore={setPendingSnapshot} />}
                    {children}

                    {/* Section 5: Move to trash */}
                    {canWrite && (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => setDeleteOpen(true)}>
                                <Trash2 className="h-4 w-4 mr-2" /> Move to trash
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
            <RestoreVersionDialog path={path} snapshot={pendingSnapshot} onClose={() => setPendingSnapshot(null)} />
        </>
    );
}
