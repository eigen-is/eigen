// LinkDrive is how a visitor without a login reaches a Drive: only the reads a route answers without a user, such as
// a folder listing or a download. Each runs the link rule on the path's breadcrumb first and answers the same 403
// for every refusal, so a visitor can't tell a private path from one that does not exist. What it hands out is
// trimmed, so no answer names a private folder above the public path or who else has access.

import type { DrivePath } from '@workspace/lib/types/drive';
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

    // The chain from the public path down. Every other read starts here, so this is where the rule runs.
    public async breadCrumb(mountId: string, pathId: string): Promise<DrivePath[]> {
        const chain = await this.drive.breadCrumb(mountId, pathId);
        const publicPath = canReadByLink(chain, arePublicLinksEnabled());
        if (publicPath === null) throw new ApiError(403, 'No read permission');
        return chain.slice(publicPath).map((path, index) => trimmed(path, index === 0));
    }

    public async getPath(mountId: string, pathId: string): Promise<DrivePath> {
        return (await this.resolveFile(mountId, pathId)).path;
    }

    public async resolveFile(mountId: string, pathId: string): Promise<{ mount: Mount; path: DrivePath }> {
        const crumbs = await this.breadCrumb(mountId, pathId);
        const { mount, path } = await this.drive.resolveFile(mountId, pathId);
        return { mount, path: trimmed(path, crumbs.length === 1) };
    }

    public async getFolderContents(mountId: string, pathId: string): Promise<DrivePath[]> {
        const crumbs = await this.breadCrumb(mountId, pathId);
        const children = await this.drive.getFolderContents(mountId, pathId);
        return children
            .filter((child) => canReadByLink([...crumbs, child], arePublicLinksEnabled()) !== null)
            .map((child) => trimmed(child, false));
    }
}
