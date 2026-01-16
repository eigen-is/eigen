import type {S3Config} from '../storage/types';

export interface MountConfig {
    id: string;
    name: string;
    storageType: 'local-key' | 's3';
    isDefault: boolean;
    localPath?: string;
    s3Config?: S3Config;
    createdAt?: Date;
    updatedAt?: Date;
}

export interface PathEntry {
    id: string;
    name: string;
    type: 'folder' | 'file' | 'doc' | 'stickies';
    parentId: string | null;
    ownerId: string;
    mimeType: string;
    size: number;
    thumbnail: string | null;
    acl: ACLEntry[] | null;
    labels?: string[];
    createdAt: Date;
    updatedAt: Date;
}

export interface ACLEntry {
    email: string;
    read: boolean;
    write: boolean;
    public?: boolean;
}

export interface MountInfo {
    id: string;
    name: string;
    storageType: 'local-key' | 's3';
    isDefault: boolean;
    totalSize: number;
    fileCount: number;
}
