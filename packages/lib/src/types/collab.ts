import type {DrivePath} from './drive';

export type CollabDocumentInfo = {
    canRead: boolean;
    canWrite: boolean;
    path: DrivePath | null;
    folderContents: DrivePath[] | null;
};

export type CollabRevision = {
    id: number;
    createdAt: string | null;
};
