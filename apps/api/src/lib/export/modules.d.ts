// A `with { type: 'file' }` import is the asset's path.
declare module '*.py' {
    const path: string;
    export default path;
}
