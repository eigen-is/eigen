// LinkDrive is how a visitor without a login reaches a Drive: only the reads a route answers without a user, such as
// a folder listing or a download. Each runs the link rule on the path's breadcrumb first and refuses every path alike,
// with a 403 or canRead's false, so a visitor can't tell a private path from one that does not exist. An answer holds
// no ACL and a breadcrumb starts at the public path, so a visitor reads what a sharee reads, while the file handed to
// the code that serves it stays whole, so a visitor gets the same preview as a member.

import type { DrivePath } from '@workspace/lib/types/drive';
import type { CollabDocument } from '../collab/collab-document';
import { arePublicLinksEnabled } from '../config/server-settings';
import { ApiError } from '../core';
import type { Home } from '../home';
import type { Mount } from '../mount';
import { canReadByLink } from './acl';
import type { Drive } from './drive';

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
        return chain.map(withoutAcl);
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
        return children.filter((child) => canReadByLink([...crumbs, child]) !== null).map(withoutAcl);
    }

    public async getCollabDocument(mountId: string, pathId: string): Promise<CollabDocument> {
        await this.breadCrumb(mountId, pathId);
        return this.drive.getCollabDocument(mountId, pathId);
    }

    // The chain from the public path down, or null while public links are off or where the link rule refuses the path.
    private async publicChain(mountId: string, pathId: string): Promise<DrivePath[] | null> {
        if (!arePublicLinksEnabled()) return null;
        const chain = await this.drive.breadCrumb(mountId, pathId);
        const publicPath = canReadByLink(chain);
        return publicPath === null ? null : chain.slice(publicPath);
    }
}

function withoutAcl(path: DrivePath): DrivePath {
    return { ...path, acl: null };
}
