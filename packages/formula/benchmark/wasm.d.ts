// A WebAssembly file imported with the file attribute is its path: Bun gives the file's own path, and a bundle
// copies the file beside itself and gives the copy's path relative to the bundle.

declare module '*.wasm' {
    const path: string;
    export default path;
}
