import { Transform, type TransformCallback } from 'node:stream';
import MimeNode from './mime-node';

const MAX_HEAD_SIZE = 1 * 1024 * 1024;
const MAX_CHILD_NODES = 1000;

const HEAD = 0x01;
const BODY = 0x02;

type SplitterConfig = {
    maxHeadSize?: number;
    maxChildNodes?: number;
    Iconv?: unknown;
    ignoreEmbedded?: boolean;
    defaultInlineEmbedded?: boolean;
};

type SplitterData = {
    node: MimeNode;
    type: string;
    value?: Buffer;
};

type ProcessLineCallback = (err?: Error | null, data?: MimeNode | SplitterData | null, flush?: boolean) => void;

class MessageSplitter extends Transform {
    config: SplitterConfig;
    maxHeadSize: number;
    maxChildNodes: number;
    tree: MimeNode[];
    nodeCounter: number;
    node!: MimeNode;
    state!: number;
    line: Buffer | null;
    hasFailed: boolean;

    constructor(config?: SplitterConfig) {
        super({
            readableObjectMode: true,
            writableObjectMode: false,
        });

        this.config = config || {};
        this.maxHeadSize = this.config.maxHeadSize || MAX_HEAD_SIZE;
        this.maxChildNodes = this.config.maxChildNodes || MAX_CHILD_NODES;
        this.tree = [];
        this.nodeCounter = 0;
        this.newNode();
        this.tree.push(this.node);
        this.line = null;
        this.hasFailed = false;
    }

    _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
        let pos = 0;
        let i = 0;
        let group: { type: string; node?: MimeNode; value?: Buffer } = {
            type: 'none',
        };
        let groupstart = this.line ? -this.line.length : 0;
        let groupend = 0;

        const checkTrailingLinebreak = (data: SplitterData) => {
            if (data.type === 'body' && data.node.parentNode && data.value?.length) {
                if (data.value[data.value.length - 1] === 0x0a) {
                    groupstart--;
                    groupend--;
                    pos--;
                    if (data.value.length > 1 && data.value[data.value.length - 2] === 0x0d) {
                        groupstart--;
                        groupend--;
                        pos--;
                        if (groupstart < 0 && !this.line) {
                            this.line = Buffer.allocUnsafe(1);
                            this.line[0] = 0x0d;
                        }
                        data.value = data.value.slice(0, data.value.length - 2);
                    } else {
                        data.value = data.value.slice(0, data.value.length - 1);
                    }
                } else if (data.value[data.value.length - 1] === 0x0d) {
                    groupstart--;
                    groupend--;
                    pos--;
                    data.value = data.value.slice(0, data.value.length - 1);
                }
            }
        };

        const iterateData = () => {
            for (const len = chunk.length; i < len; i++) {
                if (chunk[i] === 0x0a) {
                    const start = Math.max(pos, 0);
                    pos = ++i;

                    return this.processLine(chunk.slice(start, i), false, (err, data, flush) => {
                        if (err) {
                            this.hasFailed = true;
                            return process.nextTick(() => callback(err));
                        }

                        if (!data) {
                            return process.nextTick(iterateData);
                        }

                        if (flush) {
                            if (group && group.type !== 'none') {
                                if (group.type === 'body' && groupend >= groupstart && group.node?.parentNode) {
                                    if (chunk[groupend - 1] === 0x0a) {
                                        groupend--;
                                        if (groupend >= groupstart && chunk[groupend - 1] === 0x0d) {
                                            groupend--;
                                        }
                                    }
                                }
                                if (groupstart !== groupend) {
                                    group.value = chunk.slice(groupstart, groupend);
                                    if (groupend < i) {
                                        (data as SplitterData).value = chunk.slice(groupend, i);
                                    }
                                }
                                this.push(group);
                                group = {
                                    type: 'none',
                                };
                                groupstart = groupend = i;
                            }
                            this.push(data);
                            groupend = i;
                            return process.nextTick(iterateData);
                        }

                        const dataObj = data as SplitterData;
                        if (dataObj.type === group.type) {
                            groupend = i;
                        } else {
                            if (group.type === 'body' && groupend >= groupstart && group.node?.parentNode) {
                                if (chunk[groupend - 1] === 0x0a) {
                                    groupend--;
                                    if (groupend >= groupstart && chunk[groupend - 1] === 0x0d) {
                                        groupend--;
                                    }
                                }
                            }

                            if (group.type !== 'none' && group.type !== 'node') {
                                if (groupstart !== groupend) {
                                    group.value = chunk.slice(groupstart, groupend);
                                    if (group.value?.length) {
                                        this.push(group);
                                        group = {
                                            type: 'none',
                                        };
                                    }
                                }
                            }

                            if (dataObj.type === 'node') {
                                this.push(data);
                                groupstart = i;
                                groupend = i;
                            } else if (groupstart < 0) {
                                groupstart = i;
                                groupend = i;
                                checkTrailingLinebreak(dataObj);
                                if (dataObj.value?.length) {
                                    this.push(data);
                                }
                            } else {
                                group = dataObj;
                                groupstart = groupend;
                                groupend = i;
                            }
                        }
                        return process.nextTick(iterateData);
                    });
                }
            }

            if (pos >= groupstart + 1 && group.type === 'body' && group.node?.parentNode) {
                if (chunk[pos - 1] === 0x0a) {
                    pos--;
                    if (pos >= groupstart && chunk[pos - 1] === 0x0d) {
                        pos--;
                    }
                }
            }

            if (group.type !== 'none' && group.type !== 'node' && pos > groupstart) {
                group.value = chunk.slice(groupstart, pos);

                if (group.value?.length) {
                    this.push(group);
                    group = {
                        type: 'none',
                    };
                }
            }

            if (pos < chunk.length) {
                if (this.line) {
                    this.line = Buffer.concat([this.line, chunk.slice(pos)]);
                } else {
                    this.line = chunk.slice(pos);
                }
            }
            callback();
        };

        process.nextTick(iterateData);
    }

    _flush(callback: TransformCallback): void {
        if (this.hasFailed) {
            callback();
            return;
        }
        this.processLine(null, true, (err, data) => {
            if (err) {
                return process.nextTick(() => callback(err));
            }
            if (data) {
                if (data instanceof MimeNode) {
                    this.push(data);
                } else if ((data as SplitterData).value && (data as SplitterData).value!.length) {
                    this.push(data);
                }
            }
            callback();
        });
    }

    compareBoundary(line: Buffer, startpos: number, boundary: Buffer): number | false {
        if (line.length < boundary.length + 3 + startpos || line.length > boundary.length + 6 + startpos) {
            return false;
        }
        for (let i = 0; i < boundary.length; i++) {
            if (line[i + 2 + startpos] !== boundary[i]) {
                return false;
            }
        }

        let pos = 0;
        for (let i = boundary.length + 2 + startpos; i < line.length; i++) {
            const c = line[i];
            if (pos === 0 && (c === 0x0d || c === 0x0a)) {
                return 1;
            }
            if (pos === 0 && c !== 0x2d) {
                return false;
            }
            if (pos === 1 && c !== 0x2d) {
                return false;
            }
            if (pos === 2 && c !== 0x0d && c !== 0x0a) {
                return false;
            }
            if (pos === 3 && c !== 0x0a) {
                return false;
            }
            pos++;
        }

        return 2;
    }

    checkBoundary(line: Buffer): number | false {
        let startpos = 0;
        if (line.length >= 1 && (line[0] === 0x0d || line[0] === 0x0a)) {
            startpos++;
            if (line.length >= 2 && (line[0] === 0x0d || line[1] === 0x0a)) {
                startpos++;
            }
        }
        if (line.length < 4 || line[startpos] !== 0x2d || line[startpos + 1] !== 0x2d) {
            return false;
        }

        let boundary: number | false;
        if (this.node._boundary && (boundary = this.compareBoundary(line, startpos, this.node._boundary))) {
            return boundary;
        }

        if (this.node._parentBoundary && (boundary = this.compareBoundary(line, startpos, this.node._parentBoundary))) {
            return boundary + 2;
        }

        return false;
    }

    processLine(line: Buffer | null, final: boolean, next: ProcessLineCallback): void {
        let flush = false;

        if (this.line && line) {
            line = Buffer.concat([this.line, line]);
            this.line = null;
        } else if (this.line && !line) {
            line = this.line;
            this.line = null;
        }

        if (!line) {
            line = Buffer.alloc(0);
        }

        if (this.nodeCounter > this.maxChildNodes) {
            const err = new Error('Max allowed child nodes exceeded') as Error & { code: string };
            err.code = 'EMAXLEN';
            next(err);
            return;
        }

        const boundary = this.checkBoundary(line);
        if (boundary) {
            switch (boundary) {
                case 1:
                    this.newNode(this.node);
                    flush = true;
                    break;
                case 2:
                    break;
                case 3: {
                    let parentNode = this.node.parentNode;
                    if (parentNode && parentNode.contentType === 'message/rfc822') {
                        parentNode = parentNode.parentNode;
                    }
                    this.newNode(parentNode || undefined);
                    flush = true;
                    break;
                }
                case 4:
                    if (this.node?._headerlen && !this.node.headers) {
                        this.node.parseHeaders();
                        this.push(this.node);
                    }
                    if (this.tree.length) {
                        this.node = this.tree.pop()!;
                    }
                    this.state = BODY;
                    break;
            }

            next(
                null,
                {
                    node: this.node,
                    type: 'data',
                    value: line,
                },
                flush,
            );
            return;
        }

        switch (this.state) {
            case HEAD: {
                this.node.addHeaderChunk(line);
                if (this.node._headerlen > this.maxHeadSize) {
                    const err = new Error('Max header size for a MIME node exceeded') as Error & { code: string };
                    err.code = 'EMAXLEN';
                    next(err);
                    return;
                }
                if (
                    final ||
                    (line.length === 1 && line[0] === 0x0a) ||
                    (line.length === 2 && line[0] === 0x0d && line[1] === 0x0a)
                ) {
                    const currentNode = this.node;

                    currentNode.parseHeaders();

                    if (
                        currentNode.contentType === 'message/rfc822' &&
                        !this.config.ignoreEmbedded &&
                        (!currentNode.encoding || ['7bit', '8bit', 'binary'].includes(currentNode.encoding)) &&
                        (this.config.defaultInlineEmbedded
                            ? currentNode.disposition !== 'attachment'
                            : currentNode.disposition === 'inline')
                    ) {
                        currentNode.messageNode = true;
                        this.newNode(currentNode);
                        if (currentNode.parentNode) {
                            this.node._parentBoundary = (currentNode.parentNode as MimeNode)._boundary;
                        }
                    } else {
                        if (currentNode.contentType === 'message/rfc822') {
                            currentNode.messageNode = false;
                        }
                        this.state = BODY;
                        if (currentNode.multipart && currentNode._boundary) {
                            this.tree.push(currentNode);
                        }
                    }

                    next(null, currentNode, flush);
                    return;
                }

                next();
                return;
            }
            case BODY: {
                next(
                    null,
                    {
                        node: this.node,
                        type: this.node.multipart ? 'data' : 'body',
                        value: line,
                    },
                    flush,
                );
                return;
            }
        }

        next(null, null);
    }

    newNode(parent?: MimeNode | null): void {
        this.node = new MimeNode(parent ?? null, this.config);
        this.state = HEAD;
        this.nodeCounter++;
    }
}

export default MessageSplitter;
