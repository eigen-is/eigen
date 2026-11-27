// LinkDrive is how a visitor without a login reaches a Drive: only the reads a route answers without a user, such as
// a folder listing or a download. Each runs the link rule on the path's breadcrumb first and refuses every path alike,
// with a 403 or canRead's false, so a visitor can't tell a private path from one that does not exist. An answer holds
// no ACL and a breadcrumb starts at the public path, so a visitor reads what a sharee reads, while the file handed to
// the code that serves it stays whole, so a visitor gets the same preview as a reader by name.

import type { DrivePath } from '@workspace/lib/types/drive';
import { arePublicLinksEnabled } from '../config/server-settings';
import { ApiError } from '../core';
import { getHome } from '../home';
import type { Mount } from '../mount';
import { canReadByLink } from './acl';
import type { Drive } from './drive';

// The owner's drive, with the breadcrumb from the public path down.
type PublicChain = { drive: Drive; chain: DrivePath[] };

export class LinkDrive {
    private readonly ownerId: string;

    public constructor(ownerId: string) {
        this.ownerId = ownerId;
    }

    public async canRead(mountId: string, pathId: string): Promise<boolean> {
        return (await this.publicChain(mountId, pathId)) !== null;
    }

    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        return (await this.readable(mountId, pathId)).chain.map(withoutAcl);
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath | null> {
        return (await this.breadCrumb(mountId, pathId)).at(-1) ?? null;
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        return (await this.readable(mountId, pathId)).drive.resolveFile(mountId, pathId);
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const { drive, chain } = await this.readable(mountId, pathId);
        const children = await drive.getFolderContents(mountId, pathId);
        return children.filter((child) => canReadByLink([...chain, child]) !== null).map(withoutAcl);
    }

    // Every read starts here, so this is where a refusal is thrown.
    private async readable(mountId: string, pathId: string): Promise<PublicChain> {
        const found = await this.publicChain(mountId, pathId);
        if (found === null) throw new ApiError(403, 'No read permission');
        return found;
    }

    // Null while public links are off, asked before the owner's Home is opened, or where the link rule refuses the path.
    private async publicChain(mountId: string, pathId: string): Promise<PublicChain | null> {
        if (!arePublicLinksEnabled()) return null;
        const { drive } = await getHome(this.ownerId); // ownerId-routed: the request is for this owner's home
        const chain = await drive.breadCrumb(mountId, pathId);
        const publicPath = canReadByLink(chain);
        return publicPath === null ? null : { drive, chain: chain.slice(publicPath) };
    }
}

function withoutAcl(path: DrivePath): DrivePath {
    return { ...path, acl: null };
}
