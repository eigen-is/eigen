import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { useCallback, useState } from 'react';

function useDialogState() {
    const [open, setOpen] = useState(false);
    const openDialog = useCallback(() => setOpen(true), []);
    const closeDialog = useCallback(() => setOpen(false), []);
    return { open, setOpen, openDialog, closeDialog };
}

// One dialog-open state per EigenDocType. Each entry is its own useState pair (hooks
// rules); the helper just buckets them under a single key so consumers don't have to
// name each kind.
function useEigenDocDialogs(): Record<EigenDocType, ReturnType<typeof useDialogState>> {
    return {
        doc: useDialogState(),
        stickies: useDialogState(),
        slides: useDialogState(),
        sheets: useDialogState(),
        chat: useDialogState(),
    };
}

export function useDriveDialogs() {
    const createFolder = useDialogState();
    const create = useEigenDocDialogs();

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteItems, setDeleteItems] = useState<DrivePath[]>([]);

    const [renameOpen, setRenameOpen] = useState(false);
    const [renameItem, setRenameItem] = useState<DrivePath | null>(null);

    const [shareOpen, setShareOpen] = useState(false);
    const [shareItem, setShareItem] = useState<DrivePath | null>(null);

    const [emailOpen, setEmailOpen] = useState(false);
    const [emailItem, setEmailItem] = useState<DrivePath | null>(null);

    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);

    const [copyMoveOpen, setCopyMoveOpen] = useState(false);
    const [copyMoveItems, setCopyMoveItems] = useState<DrivePath[]>([]);
    const [copyMoveMode, setCopyMoveMode] = useState<'move' | 'copy'>('copy');

    const openDelete = useCallback((items: DrivePath | DrivePath[]) => {
        setDeleteItems(Array.isArray(items) ? items : [items]);
        setDeleteOpen(true);
    }, []);
    const closeDelete = useCallback(() => {
        setDeleteOpen(false);
        setDeleteItems([]);
    }, []);

    const openRename = useCallback((item: DrivePath) => {
        setRenameItem(item);
        setRenameOpen(true);
    }, []);
    const closeRename = useCallback(() => {
        setRenameOpen(false);
        setRenameItem(null);
    }, []);

    const openShare = useCallback((item: DrivePath) => {
        setShareItem(item);
        setShareOpen(true);
    }, []);
    const closeShare = useCallback(() => {
        setShareOpen(false);
        setShareItem(null);
    }, []);

    const openEmail = useCallback((item: DrivePath) => {
        setEmailItem(item);
        setEmailOpen(true);
    }, []);
    const closeEmail = useCallback(() => {
        setEmailOpen(false);
        setEmailItem(null);
    }, []);

    const openUpload = useCallback((files: File[] = []) => {
        setUploadFiles(files);
        setUploadOpen(true);
    }, []);
    const closeUpload = useCallback(() => {
        setUploadOpen(false);
        setUploadFiles([]);
    }, []);

    const openCopyMove = useCallback((items: DrivePath[], mode: 'move' | 'copy') => {
        setCopyMoveItems(items);
        setCopyMoveMode(mode);
        setCopyMoveOpen(true);
    }, []);
    const closeCopyMove = useCallback(() => {
        setCopyMoveOpen(false);
        setCopyMoveItems([]);
    }, []);

    return {
        createFolder,
        create,
        delete: {
            open: deleteOpen,
            items: deleteItems,
            setOpen: setDeleteOpen,
            openDialog: openDelete,
            closeDialog: closeDelete,
        },
        rename: {
            open: renameOpen,
            item: renameItem,
            setOpen: setRenameOpen,
            openDialog: openRename,
            closeDialog: closeRename,
        },
        share: {
            open: shareOpen,
            item: shareItem,
            setOpen: setShareOpen,
            openDialog: openShare,
            closeDialog: closeShare,
        },
        email: {
            open: emailOpen,
            item: emailItem,
            setOpen: setEmailOpen,
            openDialog: openEmail,
            closeDialog: closeEmail,
        },
        upload: {
            open: uploadOpen,
            files: uploadFiles,
            setOpen: setUploadOpen,
            openDialog: openUpload,
            closeDialog: closeUpload,
        },
        copyMove: {
            open: copyMoveOpen,
            items: copyMoveItems,
            mode: copyMoveMode,
            setOpen: setCopyMoveOpen,
            openDialog: openCopyMove,
            closeDialog: closeCopyMove,
        },
    };
}
