import { Transform, type TransformCallback } from 'node:stream';
import FlowedDecoder from './flowed-decoder';
import type MimeNode from './mime-node';

type StreamData =
    | {
          type: string;
          value?: Buffer;
          node?: MimeNode;
      }
    | MimeNode;

type DecoderStream = Transform & { $reading?: boolean };

type StreamerNodeInfo = {
    node: MimeNode;
    decoder: DecoderStream;
    done: () => void;
};

type FilterFunc = (data: MimeNode) => boolean;

class NodeStreamer extends Transform {
    filterFunc: FilterFunc;
    streamAction: unknown;

    decoder: DecoderStream | null;
    canContinue: boolean;
    continue: (() => void) | null;

    constructor(filterFunc: FilterFunc, streamAction: unknown) {
        super({
            readableObjectMode: true,
            writableObjectMode: true,
        });

        this.filterFunc = filterFunc;
        this.streamAction = streamAction;

        this.decoder = null;
        this.canContinue = false;
        this.continue = null;
    }

    _transform(data: StreamData, _encoding: BufferEncoding, callback: TransformCallback): void {
        this.processIncoming(data, callback);
    }

    _flush(callback: TransformCallback): void {
        if (this.decoder) {
            this.processIncoming({ type: 'none' }, callback);
            return;
        }
        callback();
    }

    processIncoming(data: StreamData, callback: TransformCallback): void {
        const dataObj = data as { type: string; value?: Buffer; node?: MimeNode };

        if (this.decoder && dataObj.type === 'body') {
            this.push(data);
            if (!this.decoder.write(dataObj.value)) {
                this.decoder.once('drain', callback);
                return;
            }
            callback();
            return;
        }

        if (this.decoder && dataObj.type !== 'body') {
            const decoder = this.decoder;
            const doContinue = () => {
                this.continue = null;
                this.decoder = null;
                this.canContinue = false;
                this.processIncoming(data, callback);
            };

            if (this.canContinue) {
                process.nextTick(doContinue);
            } else {
                this.continue = () => doContinue();
            }

            decoder.end();
            return;
        }

        if (dataObj.type === 'node' && this.filterFunc(data as MimeNode)) {
            this.push(data);
            this.emit('node', this.createDecoder(data as MimeNode));
        } else if (this.readable && dataObj.type !== 'none') {
            this.push(data);
        }
        callback();
    }

    createDecoder(node: MimeNode): StreamerNodeInfo {
        this.decoder = node.getDecoder() as DecoderStream;

        let decoder: DecoderStream = this.decoder;
        decoder.$reading = false;

        if (/^text\//.test(node.contentType as string) && node.flowed) {
            const flowDecoder = decoder;
            decoder = new FlowedDecoder({
                delSp: node.delSp,
            }) as DecoderStream;
            flowDecoder.on('error', (err: Error) => {
                decoder.emit('error', err);
            });
            flowDecoder.pipe(decoder);
        }

        return {
            node,
            decoder,
            done: () => {
                if (typeof this.continue === 'function') {
                    this.continue();
                } else {
                    this.canContinue = true;
                }
            },
        };
    }
}

export default NodeStreamer;
