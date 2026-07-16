export function isProduction(): boolean {
    return process.env['PRODUCTION'] === '1' || process.env['NODE_ENV'] === 'production';
}

export function isTest(): boolean {
    return process.env['NODE_ENV'] === 'test';
}

export function isDemo(): boolean {
    return process.env['EIGEN_DEMO'] === '1';
}
