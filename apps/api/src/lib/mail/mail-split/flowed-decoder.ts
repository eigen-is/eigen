import { Transform, type TransformCallback } from 'node:stream';
import libmime from 'libmime';

type FlowedDecoderConfig = {
    Iconv?: unknown;
    encoding?: string;
    delSp?: boolean;
};

class FlowedDecoder extends Transform {
    config: FlowedDecoderConfig;
    chunks: Buffer[];
    chunklen: number;
    libmime: InstanceType<typeof libmime.Libmime>;

    constructor(config?: FlowedDecoderConfig) {
        super();
        this.config = config || {};

        this.chunks = [];
        this.chunklen = 0;

        this.libmime = new libmime.Libmime({ Iconv: this.config.Iconv });
    }

    _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
        if (!chunk || !(chunk as Buffer).length) {
            callback();
            return;
        }

        // Node.js passes encoding='buffer' when chunk is already a Buffer,
        // but TypeScript's BufferEncoding doesn't include 'buffer'
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, encoding);

        this.chunks.push(buf);
        this.chunklen += buf.length;

        callback();
    }

    _flush(callback: TransformCallback): void {
        if (this.chunklen) {
            let currentBody = Buffer.concat(this.chunks, this.chunklen);

            if (this.config.encoding === 'base64') {
                currentBody = Buffer.from(currentBody.toString('binary'), 'base64');
            }

            const content = this.libmime.decodeFlowed(currentBody.toString('binary'), this.config.delSp);
            this.push(Buffer.from(content, 'binary'));
        }
        callback();
    }
}

export default FlowedDecoder;
