export function isProduction(): boolean {
    return process.env['PRODUCTION'] === '1' || process.env['NODE_ENV'] === 'production';
}
