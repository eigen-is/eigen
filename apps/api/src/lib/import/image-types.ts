// The image types an import stores a picture part as, each under its own extension. WMF and EMF are kept though no
// browser or sharp draws them: the docx reader leaves its figure's alt text in a broken image.
export const IMAGE_EXTENSION_BY_MIME = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['image/tiff', 'tiff'],
    ['image/bmp', 'bmp'],
    ['image/x-wmf', 'wmf'],
    ['image/x-emf', 'emf'],
]);

// image/jpg is a common misspelling of a part's declared type.
export const MIME_ALIASES = new Map([['image/jpg', 'image/jpeg']]);
