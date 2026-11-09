// Lets a React style object carry CSS custom properties, such as `--peer-color`, next to the
// typed ones. Every app's and React package's tsconfig pulls it in through the shared asset declarations.

export {};

declare module 'react' {
    interface CSSProperties {
        [key: `--${string}`]: string | number | undefined;
    }
}
