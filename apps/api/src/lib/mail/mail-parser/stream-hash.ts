import { Transform, type TransformCallback } from 'node:stream';

type HashableAttachment = {
    checksum: string;
    size: number;
};

class StreamHash extends Transform {
    private readonly attachment: HashableAttachment;
    private readonly hasher: Bun.CryptoHasher;
    private byteCount = 0;

    constructor(attachment: HashableAttachment, algo?: string) {
        super();
        this.attachment = attachment;
        this.hasher = new Bun.CryptoHasher((algo || 'md5').toLowerCase() as 'md5');
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
        this.hasher.update(chunk);
        this.byteCount += chunk.length;
        done(null, chunk);
    }

    _flush(done: TransformCallback): void {
        this.attachment.checksum = this.hasher.digest('hex');
        this.attachment.size = this.byteCount;
        done();
    }
}

export default StreamHash;
