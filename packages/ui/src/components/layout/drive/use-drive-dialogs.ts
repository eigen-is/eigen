import type { DrivePath } from '@workspace/lib/types/drive';
import { useCallback, useState } from 'react';

export type DriveDialogsState = {
    createFolder: { open: boolean };
    createDoc: { open: boolean };
    createStickies: { open: boolean };
    delete: { open: boolean; items: DrivePath[] };
    rename: { open: boolean; item: DrivePath | null };
    share: { open: boolean; item: DrivePath | null };
    upload: { open: boolean; files: File[] };
};

function useDialogState() {
    const [open, setOpen] = useState(false);
    const openDialog = useCallback(() => setOpen(true), []);
    const closeDialog = useCallback(() => setOpen(false), []);
    return { open, setOpen, openDialog, closeDialog };
}

export function useDriveDialogs() {
    const createFolder = useDialogState();
    const createDoc = useDialogState();
    const createStickies = useDialogState();
    const createChat = useDialogState();
    const createSlides = useDialogState();
    const createSheets = useDialogState();

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteItems, setDeleteItems] = useState<DrivePath[]>([]);

    const [renameOpen, setRenameOpen] = useState(false);
    const [renameItem, setRenameItem] = useState<DrivePath | null>(null);

    const [shareOpen, setShareOpen] = useState(false);
    const [shareItem, setShareItem] = useState<DrivePath | null>(null);

    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);

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

    const openUpload = useCallback((files: File[] = []) => {
        setUploadFiles(files);
        setUploadOpen(true);
    }, []);
    const closeUpload = useCallback(() => {
        setUploadOpen(false);
        setUploadFiles([]);
    }, []);

    return {
        createFolder,
        createDoc,
        createStickies,
        createChat,
        createSlides,
        createSheets,
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
        upload: {
            open: uploadOpen,
            files: uploadFiles,
            setOpen: setUploadOpen,
            openDialog: openUpload,
            closeDialog: closeUpload,
        },
    };
}
