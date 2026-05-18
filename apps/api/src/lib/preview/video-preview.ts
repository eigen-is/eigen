export function isVideoCandidate(mimeType: string): boolean {
    return mimeType.startsWith('video/');
}
