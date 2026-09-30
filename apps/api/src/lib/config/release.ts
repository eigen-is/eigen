// What a release is made of, for the CLI that pins it and the server backup that records the pins.
// IMAGES in ./eigen.
export const IMAGE_NAMES = ['api', 'frontend', 'postfix', 'dovecot', 'unbound'] as const;
// The keys of the pins the launcher resolves on the host, where the Docker socket is; PINS in ./eigen holds them as
// key=value lines.
const imageKey = (name: (typeof IMAGE_NAMES)[number]) => `EIGEN_${name.toUpperCase()}_IMAGE`;
export const PIN_KEYS = ['EIGEN_REGISTRY', 'EIGEN_VERSION', ...IMAGE_NAMES.map(imageKey)];
// The build a pinned install runs.
export const API_IMAGE_KEY = imageKey('api');
