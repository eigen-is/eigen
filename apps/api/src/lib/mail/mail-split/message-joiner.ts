import { Transform, type TransformCallback } from 'node:stream';
import type MimeNode from './mime-node';

type SplitterObject = Buffer | MimeNode | { type: string; value?: Buffer; node?: MimeNode };

class MessageJoiner extends Transform {
    constructor() {
        super({
            readableObjectMode: false,
            writableObjectMode: true,
        });
    }

    _transform(obj: SplitterObject, _encoding: BufferEncoding, callback: TransformCallback): void {
        if (Buffer.isBuffer(obj)) {
            this.push(obj);
        } else if ('type' in obj && obj.type === 'node') {
            this.push((obj as MimeNode).getHeaders());
        } else if ('value' in obj && obj.value) {
            this.push(obj.value);
        }
        callback();
    }

    _flush(callback: TransformCallback): void {
        callback();
    }
}

export default MessageJoiner;
