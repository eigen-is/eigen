// The open state of every dialog a Drive view's actions open, such as rename, share or the copy and
// move picker, with the items each one acts on. The Drive action runner opens them and renders them.

import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import { useState } from 'react';

function useDialogState() {
    const [open, setOpen] = useState(false);
    return { open, setOpen, openDialog: () => setOpen(true) };
}

// One dialog-open state per EigenDocType. Each entry is its own useState pair (the rules of hooks), so
// they are listed by hand under one key.
function useEigenDocDialogs(): Record<EigenDocType, ReturnType<typeof useDialogState>> {
    return {
        doc: useDialogState(),
        stickies: useDialogState(),
        slides: useDialogState(),
        sheets: useDialogState(),
        chat: useDialogState(),
        vector: useDialogState(),
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

    return {
        createFolder,
        create,
        delete: {
            open: deleteOpen,
            items: deleteItems,
            setOpen: setDeleteOpen,
            openDialog: (items: DrivePath[]) => {
                setDeleteItems(items);
                setDeleteOpen(true);
            },
            closeDialog: () => {
                setDeleteOpen(false);
                setDeleteItems([]);
            },
        },
        rename: {
            open: renameOpen,
            item: renameItem,
            setOpen: setRenameOpen,
            openDialog: (item: DrivePath) => {
                setRenameItem(item);
                setRenameOpen(true);
            },
        },
        share: {
            open: shareOpen,
            item: shareItem,
            setOpen: setShareOpen,
            openDialog: (item: DrivePath) => {
                setShareItem(item);
                setShareOpen(true);
            },
        },
        email: {
            open: emailOpen,
            item: emailItem,
            setOpen: setEmailOpen,
            openDialog: (item: DrivePath) => {
                setEmailItem(item);
                setEmailOpen(true);
            },
            closeDialog: () => {
                setEmailOpen(false);
                setEmailItem(null);
            },
        },
        upload: {
            open: uploadOpen,
            files: uploadFiles,
            setOpen: setUploadOpen,
            openDialog: (files: File[] = []) => {
                setUploadFiles(files);
                setUploadOpen(true);
            },
            closeDialog: () => {
                setUploadOpen(false);
                setUploadFiles([]);
            },
        },
        copyMove: {
            open: copyMoveOpen,
            items: copyMoveItems,
            mode: copyMoveMode,
            setOpen: setCopyMoveOpen,
            openDialog: (items: DrivePath[], mode: 'move' | 'copy') => {
                setCopyMoveItems(items);
                setCopyMoveMode(mode);
                setCopyMoveOpen(true);
            },
            closeDialog: () => {
                setCopyMoveOpen(false);
                setCopyMoveItems([]);
            },
        },
    };
}
