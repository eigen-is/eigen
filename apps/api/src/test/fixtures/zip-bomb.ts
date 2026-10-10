import { build, deflated } from './raw-zip';

// A zip whose directory LIES about its one entry's uncompressed size. The guards refuse on the declared
// size before they inflate anything, so the fixture needs no real payload and stays off the 200 MB
// deflate path that made the tests hit their timeout.
export function buildDeclaredSizeBombZip(entryName: string, declaredBytes: number): Buffer {
    return build([{ ...deflated(entryName, '<xml/>'), size: declaredBytes }]);
}
