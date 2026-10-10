// How long the thumbnail Worker gets per image. Worker.terminate() does not stop libvips, so sharp takes the same
// value as its own timeout. Its own module, as the main thread, the thumbnail Worker and the transform Worker all
// import it.
export const THUMBNAIL_TIMEOUT_SECONDS = 30;
