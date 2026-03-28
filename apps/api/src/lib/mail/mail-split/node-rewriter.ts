import { Transform, type TransformCallback } from 'node:stream';
import FlowedDecoder from './flowed-decoder';
import type MimeNode from './mime-node';

type RewriteData = {
    type: string;
    value?: Buffer;
    node?: MimeNode;
};

type DecoderStream = Transform & { $reading?: boolean };

type DecodePairResult = {
    node: MimeNode;
    decoder: DecoderStream;
    encoder: Transform;
};

type FilterFunc = (data: MimeNode) => boolean;
type RewriteAction = (data: DecodePairResult) => void;

class NodeRewriter extends Transform {
    filterFunc: FilterFunc;
    rewriteAction: RewriteAction;

    decoder: DecoderStream | null;
    encoder: Transform | null;
    continue: (() => void) | null;

    constructor(filterFunc: FilterFunc, rewriteAction: RewriteAction) {
        super({
            readableObjectMode: true,
            writableObjectMode: true,
        });

        this.filterFunc = filterFunc;
        this.rewriteAction = rewriteAction;

        this.decoder = null;
        this.encoder = null;
        this.continue = null;
    }

    _transform(data: RewriteData | MimeNode, _encoding: BufferEncoding, callback: TransformCallback): void {
        this.processIncoming(data, callback);
    }

    _flush(callback: TransformCallback): void {
        if (this.decoder) {
            this.processIncoming({ type: 'none' }, callback);
            return;
        }
        callback();
    }

    processIncoming(data: RewriteData | MimeNode, callback: TransformCallback): void {
        const dataObj = data as RewriteData;

        if (this.decoder && dataObj.type === 'body') {
            if (!this.decoder.write(dataObj.value)) {
                this.decoder.once('drain', callback);
                return;
            }
            callback();
            return;
        }

        if (this.decoder && dataObj.type !== 'body') {
            const decoder = this.decoder;
            this.continue = () => {
                this.continue = null;
                this.decoder = null;
                this.encoder = null;
                this.processIncoming(data, callback);
            };
            decoder.end();
            return;
        }

        if (dataObj.type === 'node' && this.filterFunc(data as MimeNode)) {
            this.emit('node', this.createDecodePair(data as MimeNode));
        } else if (this.readable && dataObj.type !== 'none') {
            this.push(data);
        }
        callback();
    }

    createDecodePair(node: MimeNode): DecodePairResult {
        this.decoder = node.getDecoder() as DecoderStream;

        if (['base64', 'quoted-printable'].includes(node.encoding)) {
            this.encoder = node.getEncoder();
        } else {
            this.encoder = node.getEncoder('quoted-printable');
        }

        let lastByte: number | null = null;

        let decoder: DecoderStream = this.decoder;
        const encoder: Transform = this.encoder;
        let firstChunk = true;
        decoder.$reading = false;

        const readFromEncoder = () => {
            decoder.$reading = true;

            const data = encoder.read() as Buffer | null;
            if (data === null) {
                decoder.$reading = false;
                return;
            }

            if (firstChunk) {
                firstChunk = false;
                if (this.readable) {
                    this.push(node);
                    if ((node as unknown as RewriteData).type === 'body') {
                        const nodeData = node as unknown as RewriteData;
                        lastByte =
                            nodeData.value?.length ? nodeData.value[nodeData.value.length - 1] : null;
                    }
                }
            }

            let writeMore = true;
            if (this.readable) {
                writeMore = this.push({
                    node,
                    type: 'body',
                    value: data,
                });
                lastByte = data?.length ? data[data.length - 1] : null;
            }

            if (writeMore) {
                return setTimeout(readFromEncoder, 0);
            }
            encoder.pause();
            setTimeout(() => {
                encoder.resume();
                setTimeout(readFromEncoder, 0);
            }, 100);
        };

        encoder.on('readable', () => {
            if (!decoder.$reading) {
                return readFromEncoder();
            }
        });

        encoder.on('end', () => {
            if (firstChunk) {
                firstChunk = false;
                if (this.readable) {
                    this.push(node);
                    if ((node as unknown as RewriteData).type === 'body') {
                        const nodeData = node as unknown as RewriteData;
                        lastByte =
                            nodeData.value?.length ? nodeData.value[nodeData.value.length - 1] : null;
                    }
                }
            }

            if (lastByte !== 0x0a) {
                this.push({
                    node,
                    type: 'body',
                    value: Buffer.from([0x0a]),
                });
            }

            if (this.continue) {
                this.continue();
            }
        });

        if (/^text\//.test(node.contentType as string) && node.flowed) {
            const flowDecoder = decoder;
            decoder = new FlowedDecoder({
                delSp: node.delSp,
                encoding: node.encoding,
            }) as DecoderStream;
            flowDecoder.on('error', (err: Error) => {
                decoder.emit('error', err);
            });
            flowDecoder.pipe(decoder);

            node.flowed = false;
            node.delSp = false;
            node.setContentType();
        }

        return {
            node,
            decoder,
            encoder,
        };
    }
}

export default NodeRewriter;
