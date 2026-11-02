import { describe, expect, test } from 'bun:test';
import { sharedMountType } from '../../lib/config/data-lock';

// Lines as a Docker Desktop container's /proc/mounts has them: the root, the bind-mounted data folder, and others.
const MOUNTS = [
    'overlay / overlay rw,relatime,lowerdir=/var/lib/docker/overlay2/l/A,upperdir=/u,workdir=/w 0 0',
    'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
    'mount0 /app/data virtiofs rw,relatime 0 0',
    'grpcfuse /mnt/old fuse.grpcfuse rw,nosuid,nodev,relatime,user_id=0,group_id=0,allow_other 0 0',
    String.raw`mount1 /mnt/my\040data virtiofs rw,relatime 0 0`,
    '/dev/vda1 /srv/eigen/data ext4 rw,relatime 0 0',
].join('\n');

describe('sharedMountType', () => {
    test('the longest mount point the folder is under decides, not the root', () => {
        expect(sharedMountType('/app/data', MOUNTS)).toBe('virtiofs');
        expect(sharedMountType('/app/data/server', MOUNTS)).toBe('virtiofs');
        expect(sharedMountType('/app/database', MOUNTS)).toBeNull();
    });

    test('an escaped space in a mount point matches the real path', () => {
        expect(sharedMountType('/mnt/my data', MOUNTS)).toBe('virtiofs');
    });

    test('a local file system gives null, a shared one its name', () => {
        expect(sharedMountType('/srv/eigen/data', MOUNTS)).toBeNull();
        expect(sharedMountType('/mnt/old/data', MOUNTS)).toBe('fuse.grpcfuse');
    });
});
