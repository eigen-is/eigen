// What a release is made of, for the CLI that pins it and the server backup that records the pins, and which of two
// releases is the newer. IMAGES in ./eigen.
const IMAGE_NAMES = ['api', 'frontend', 'postfix', 'dovecot', 'unbound'] as const;
// The keys of the pins the launcher resolves on the host, where the Docker socket is; PINS in ./eigen holds them as
// key=value lines.
const imageKey = (name: (typeof IMAGE_NAMES)[number]) => `EIGEN_${name.toUpperCase()}_IMAGE`;
export const PIN_KEYS = ['EIGEN_REGISTRY', 'EIGEN_VERSION', ...IMAGE_NAMES.map(imageKey)];
// The build a pinned install runs.
export const API_IMAGE_KEY = imageKey('api');

// Whether Eigen `appVersion`, such as the build an archive was made by, is newer than `version`. Its databases may then
// carry a schema that `version` cannot open. A whole-server restore does not check every one of them, as the documents
// of an s3 mount that stays on its bucket are never read, so it refuses such an archive. What is not a version counts
// as newer: Bun.semver.order throws on it.
export function isNewerBuild(appVersion: string, version: string): boolean {
    try {
        return Bun.semver.order(appVersion, version) > 0;
    } catch {
        return true;
    }
}
