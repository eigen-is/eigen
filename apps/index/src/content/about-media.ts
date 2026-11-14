// Where the About pages' filmed media live under the public site, such as the still beside each app on the
// overview. The site's pages link to them and the capture tool films them there, so both spell paths through here.
// It imports nothing, so the capture tool can read it without the app's dependencies.

export const ABOUT_MEDIA = '/data/about/media';

export function aboutRowStill(slug: string): string {
    return `${ABOUT_MEDIA}/row-${slug}.webp`;
}
