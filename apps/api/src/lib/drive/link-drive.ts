// LinkDrive is how a visitor without a login reaches a Drive: only the reads a route answers without a user, such as
// a folder listing or a download. Each runs the link rule on the path's breadcrumb first and refuses every path alike,
// with a 403 or canRead's false, so a visitor can't tell a private path from one that does not exist. An answer is
// trimmed, so it names no private folder above the public path and no one else with access, while the file handed to
// the code that serves it stays whole, so a visitor gets the same preview as a member.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { CollabDocument } from '../collab/collab-document';
import { arePublicLinksEnabled } from '../config/server-settings';
import { ApiError } from '../core';
import type { Home } from '../home';
import type { Mount } from '../mount';
import { canReadByLink } from './acl';
import type { Drive } from './drive';

// The parent of the public path is a private folder, so only a path below it keeps its parent id.
function trimmed(path: DrivePath, isPublicPath: boolean): DrivePath {
    return { ...path, acl: null, parentId: isPublicPath ? null : path.parentId };
}

export class LinkDrive {
    private readonly drive: Drive;

    public constructor(home: Home) {
        this.drive = home.drive;
    }

    // Holding the owner's home has no rule of its own: the caller asks canRead before it holds.
    public holdHome(onClosing?: () => void): () => void {
        return this.drive.holdHome(onClosing);
    }

    public async canRead(mountId: string, pathId: string): Promise<boolean> {
        return (await this.publicChain(mountId, pathId)) !== null;
    }

    // Every other read starts here, so this is where a refusal is thrown.
    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const chain = await this.publicChain(mountId, pathId);
        if (chain === null) throw new ApiError(403, 'No read permission');
        return chain.map((path, index) => trimmed(path, index === 0));
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return (await this.breadCrumb(mountId, pathId)).at(-1) ?? null;
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        await this.breadCrumb(mountId, pathId);
        return this.drive.resolveFile(mountId, pathId);
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const crumbs = await this.breadCrumb(mountId, pathId);
        const children = await this.drive.getFolderContents(mountId, pathId);
        return children
            .filter((child) => canReadByLink([...crumbs, child], arePublicLinksEnabled()) !== null)
            .map((child) => trimmed(child, false));
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        await this.breadCrumb(mountId, pathId);
        return this.drive.getCollabDocument(mountId, pathId);
    }

    // The chain from the public path down, or null where the link rule refuses the path.
    private async publicChain(mountId: string, pathId: string): Promise<DrivePath[] | null> {
        const chain = await this.drive.breadCrumb(mountId, pathId);
        const publicPath = canReadByLink(chain, arePublicLinksEnabled());
        return publicPath === null ? null : chain.slice(publicPath);
    }
}
