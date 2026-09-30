// What a release is made of, for the CLI that pins it and the server backup that records the pins.
// IMAGES in ./eigen.
export const IMAGE_NAMES = ['api', 'frontend', 'postfix', 'dovecot', 'unbound'] as const;
// The keys of the pins the launcher resolves on the host, where the Docker socket is; PINS in ./eigen holds them as
// key=value lines.
export const PIN_KEYS = [
    'EIGEN_REGISTRY',
    'EIGEN_VERSION',
    ...IMAGE_NAMES.map((name) => `EIGEN_${name.toUpperCase()}_IMAGE`),
];
