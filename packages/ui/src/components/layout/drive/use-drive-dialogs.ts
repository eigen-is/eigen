import {useCallback, useState} from "react";
import {DrivePath} from "@workspace/lib/types/drive";

export type DriveDialogsState = {
    createFolder: { open: boolean };
    createDoc: { open: boolean };
    createStickies: { open: boolean };
    delete: { open: boolean; item: DrivePath | null };
    rename: { open: boolean; item: DrivePath | null };
    share: { open: boolean; item: DrivePath | null };
    upload: { open: boolean; files: File[] };
}

export function useDriveDialogs() {
    const [createFolderOpen, setCreateFolderOpen] = useState(false);
    const [createDocOpen, setCreateDocOpen] = useState(false);
    const [createStickiesOpen, setCreateStickiesOpen] = useState(false);
    const [createChatOpen, setCreateChatOpen] = useState(false);

    const [deleteOpen, setDeleteOpen] = useState(false);
    const [deleteItem, setDeleteItem] = useState<DrivePath | null>(null);

    const [renameOpen, setRenameOpen] = useState(false);
    const [renameItem, setRenameItem] = useState<DrivePath | null>(null);

    const [shareOpen, setShareOpen] = useState(false);
    const [shareItem, setShareItem] = useState<DrivePath | null>(null);

    const [uploadOpen, setUploadOpen] = useState(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);

    const openCreateFolder = useCallback(() => setCreateFolderOpen(true), []);
    const closeCreateFolder = useCallback(() => setCreateFolderOpen(false), []);

    const openCreateDoc = useCallback(() => setCreateDocOpen(true), []);
    const closeCreateDoc = useCallback(() => setCreateDocOpen(false), []);

    const openCreateStickies = useCallback(() => setCreateStickiesOpen(true), []);
    const closeCreateStickies = useCallback(() => setCreateStickiesOpen(false), []);

    const openCreateChat = useCallback(() => setCreateChatOpen(true), []);
    const closeCreateChat = useCallback(() => setCreateChatOpen(false), []);

    const openDelete = useCallback((item: DrivePath) => {
        setDeleteItem(item);
        setDeleteOpen(true);
    }, []);
    const closeDelete = useCallback(() => {
        setDeleteOpen(false);
        setDeleteItem(null);
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
        createFolder: {
            open: createFolderOpen,
            setOpen: setCreateFolderOpen,
            openDialog: openCreateFolder,
            closeDialog: closeCreateFolder,
        },
        createDoc: {
            open: createDocOpen,
            setOpen: setCreateDocOpen,
            openDialog: openCreateDoc,
            closeDialog: closeCreateDoc,
        },
        createStickies: {
            open: createStickiesOpen,
            setOpen: setCreateStickiesOpen,
            openDialog: openCreateStickies,
            closeDialog: closeCreateStickies,
        },
        createChat: {
            open: createChatOpen,
            setOpen: setCreateChatOpen,
            openDialog: openCreateChat,
            closeDialog: closeCreateChat,
        },
        delete: {
            open: deleteOpen,
            item: deleteItem,
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
