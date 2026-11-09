// Types for heic-convert, which ships none. The thumbnail Worker loads it to decode a HEIC photo that sharp can't
// read into a JPEG it can resize. The encoders it wraps return a Node Buffer.

declare module 'heic-convert' {
    function convert(options: { buffer: Buffer; format: 'JPEG' | 'PNG'; quality?: number }): Promise<Buffer>;
    export default convert;
}
