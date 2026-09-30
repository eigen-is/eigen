import * as net from 'node:net';
import { escapeXml } from '@workspace/lib/html';
import type { S3Config } from '@workspace/lib/types';
import type { StorageBackend } from '../lib/storage';
import { DUMMY_S3 } from './fault-storage-helpers';

// A local S3 for the real S3Storage: faults on the lazy S3File's HEAD, GET and DELETE, which FaultStorage never sees.
// It lists what went in through it, takes multipart uploads, answers its `lifecycle`, and refuses an unsigned
// request unless `publicRead`.

// stall-body: headers and half the body, then silence; cut: half, then close; fail-get: a 500 on GET only;
// fail-put: a 500 on PUT only, every part of a multipart upload included; slow-put: each PUT and part answered
// half a second late; short-head: a HEAD one byte short; deny: a 403 AccessDenied; no-bucket: a 404 NoSuchBucket.
// HEAD and DELETE honor only stall, fail, deny, no-bucket and short-head; PUT only fail-put and slow-put.
export type S3Fault =
    | 'stall'
    | 'stall-body'
    | 'cut'
    | 'empty'
    | 'fail'
    | 'fail-get'
    | 'fail-put'
    | 'slow-put'
    | 'short-head'
    | 'deny'
    | 'no-bucket';

const SLOW_PUT_MS = 500;

export class FakeS3Server {
    // Keyed by object key.
    readonly faults = new Map<string, S3Fault>();
    readonly gets = new Map<string, number>();
    // Held requests whose client closed the connection itself.
    abandoned = 0;
    // Answer a GET without a signature, as a bucket anyone may read does.
    publicRead = false;
    // The bucket's lifecycle configuration as a GET ?lifecycle answers it; null is none.
    lifecycle: string | null = null;
    // Multipart uploads begun and neither completed nor aborted, by upload id.
    readonly openUploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
    abortedUploads = 0;
    // What a list answers: every key written through this server and not deleted since.
    private readonly listed = new Set<string>();
    private nextUploadId = 1;
    private readonly held = new Map<net.Socket, () => void>();
    private readonly sockets = new Set<net.Socket>();
    private readonly server = net.createServer((socket) => this.accept(socket));

    constructor(readonly store: StorageBackend) {}

    get heldCount(): number {
        return this.held.size;
    }

    // The returned config points an S3Storage or an s3 mount at this server.
    async start(): Promise<S3Config> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        const { port } = this.server.address() as net.AddressInfo;
        return { ...DUMMY_S3, endpoint: `http://127.0.0.1:${port}`, bucket: 'eigen' };
    }

    // Clear every fault and answer every held request in full, as a provider recovering would.
    heal(): void {
        this.faults.clear();
        const resumes = [...this.held.values()];
        this.held.clear();
        for (const resume of resumes) resume();
    }

    async stop(): Promise<void> {
        this.held.clear();
        const closed = new Promise<void>((resolve) => this.server.close(() => resolve()));
        for (const socket of this.sockets) socket.destroy();
        await closed;
    }

    private accept(socket: net.Socket): void {
        let buffered = Buffer.alloc(0);
        let answering = Promise.resolve();
        this.sockets.add(socket);
        socket.on('close', () => {
            this.sockets.delete(socket);
            if (this.held.delete(socket)) this.abandoned++;
        });
        socket.on('error', () => {});
        socket.on('data', (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            for (;;) {
                const headEnd = buffered.indexOf('\r\n\r\n');
                if (headEnd < 0) return;
                const head = buffered.subarray(0, headEnd).toString();
                const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
                if (buffered.length < headEnd + 4 + length) return;
                const body = buffered.subarray(headEnd + 4, headEnd + 4 + length);
                buffered = buffered.subarray(headEnd + 4 + length);
                answering = answering
                    .then(() => this.respond(socket, head, body))
                    .catch(() => {
                        socket.destroy();
                    });
            }
        });
    }

    private async respond(socket: net.Socket, head: string, body: Buffer): Promise<void> {
        const [method, target] = head.split(' ');
        const url = new URL(target, 'http://s3');
        const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
        const fault = this.faults.get(key);
        const signed = /^authorization:/im.test(head) || url.searchParams.has('X-Amz-Signature');
        if (!signed && !(this.publicRead && method === 'GET')) {
            reply(socket, method, '403 Forbidden', 'AccessDenied');
            return;
        }
        if (method === 'GET' && url.searchParams.has('lifecycle')) {
            if (this.lifecycle === null) reply(socket, method, '404 Not Found', 'NoSuchLifecycleConfiguration');
            else replyXml(socket, this.lifecycle);
            return;
        }
        if (method === 'PUT' && fault === 'slow-put') await Bun.sleep(SLOW_PUT_MS);
        const uploadId = url.searchParams.get('uploadId');
        if (method === 'POST' && url.searchParams.has('uploads')) {
            const id = `upload-${this.nextUploadId++}`;
            this.openUploads.set(id, { key, parts: new Map() });
            replyXml(
                socket,
                `<InitiateMultipartUploadResult><Key>${escapeXml(key)}</Key><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
            );
            return;
        }
        if (uploadId) {
            await this.multipart(socket, method, uploadId, Number(url.searchParams.get('partNumber')), body, fault);
            return;
        }
        if (method === 'GET' && url.searchParams.get('list-type') === '2') {
            await this.list(socket, url.searchParams.get('prefix') ?? '');
            return;
        }
        if (method === 'PUT') {
            if (fault === 'fail-put') {
                reply(socket, method, '500 Internal Server Error', 'InternalError');
                return;
            }
            await this.store.write(key, new Uint8Array(body));
            this.listed.add(key);
            reply(socket, method, '200 OK');
            return;
        }
        if (method === 'GET') this.gets.set(key, (this.gets.get(key) ?? 0) + 1);
        if (fault === 'stall') {
            this.held.set(socket, () => {
                this.serve(socket, method, key, head, undefined).catch(() => socket.destroy());
            });
            return;
        }
        await this.serve(socket, method, key, head, fault);
    }

    private async serve(
        socket: net.Socket,
        method: string,
        key: string,
        head: string,
        fault: S3Fault | undefined,
    ): Promise<void> {
        if (fault === 'fail' || (fault === 'fail-get' && method === 'GET')) {
            reply(socket, method, '500 Internal Server Error', 'InternalError');
            return;
        }
        if (fault === 'deny') {
            reply(socket, method, '403 Forbidden', 'AccessDenied');
            return;
        }
        if (fault === 'no-bucket') {
            reply(socket, method, '404 Not Found', 'NoSuchBucket');
            return;
        }
        if (method === 'DELETE') {
            await this.store.delete(key);
            this.listed.delete(key);
            reply(socket, method, '204 No Content');
            return;
        }
        const size = await this.store.size(key);
        if (size === null) {
            reply(socket, method, '404 Not Found', 'NoSuchKey');
            return;
        }
        if (method === 'HEAD') {
            const told = fault === 'short-head' ? size - 1 : size;
            socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${told}\r\nETag: "e"\r\n\r\n`);
            return;
        }
        if (fault === 'empty') {
            reply(socket, method, '200 OK');
            return;
        }
        const object = new Uint8Array(await this.store.read(key).arrayBuffer());
        const range = /bytes=(\d+)-(\d*)/.exec(head);
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Number(range[2]) + 1 : object.length;
        const bytes = object.subarray(start, end);
        const status = range
            ? `206 Partial Content\r\nContent-Range: bytes ${start}-${end - 1}/${object.length}`
            : '200 OK';
        socket.write(`HTTP/1.1 ${status}\r\nContent-Length: ${bytes.length}\r\n\r\n`);
        if (fault !== 'cut' && fault !== 'stall-body') {
            socket.write(bytes);
            return;
        }
        const half = bytes.length >> 1;
        socket.write(bytes.subarray(0, half));
        if (fault === 'cut') {
            socket.end();
            return;
        }
        this.held.set(socket, () => socket.write(bytes.subarray(half)));
    }

    private async multipart(
        socket: net.Socket,
        method: string,
        uploadId: string,
        partNumber: number,
        body: Buffer,
        fault: S3Fault | undefined,
    ): Promise<void> {
        const upload = this.openUploads.get(uploadId);
        if (!upload) {
            reply(socket, method, '404 Not Found', 'NoSuchUpload');
            return;
        }
        if (method === 'DELETE') {
            this.openUploads.delete(uploadId);
            this.abortedUploads++;
            reply(socket, method, '204 No Content');
            return;
        }
        if (method === 'PUT') {
            if (fault === 'fail-put') {
                reply(socket, method, '500 Internal Server Error', 'InternalError');
                return;
            }
            upload.parts.set(partNumber, Buffer.from(body));
            reply(socket, method, '200 OK');
            return;
        }
        const parts = [...upload.parts.entries()].sort(([a], [b]) => a - b).map(([, part]) => part);
        await this.store.write(upload.key, new Uint8Array(Buffer.concat(parts)));
        this.listed.add(upload.key);
        this.openUploads.delete(uploadId);
        replyXml(
            socket,
            `<CompleteMultipartUploadResult><Key>${escapeXml(upload.key)}</Key><ETag>"e"</ETag></CompleteMultipartUploadResult>`,
        );
    }

    // One page, whatever the count: nothing here lists a thousand keys.
    private async list(socket: net.Socket, prefix: string): Promise<void> {
        const contents: string[] = [];
        for (const key of [...this.listed].filter((key) => key.startsWith(prefix)).sort()) {
            const size = (await this.store.size(key)) ?? 0;
            contents.push(`<Contents><Key>${escapeXml(key)}</Key><Size>${size}</Size><ETag>"e"</ETag></Contents>`);
        }
        replyXml(
            socket,
            `<ListBucketResult><Prefix>${escapeXml(prefix)}</Prefix><KeyCount>${contents.length}</KeyCount><IsTruncated>false</IsTruncated>${contents.join('')}</ListBucketResult>`,
        );
    }
}

function replyXml(socket: net.Socket, xml: string): void {
    const payload = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${xml}`);
    socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: ${payload.length}\r\n\r\n`);
    socket.write(payload);
}

function reply(socket: net.Socket, method: string, status: string, code?: string): void {
    const payload = code && method !== 'HEAD' ? `<Error><Code>${code}</Code></Error>` : '';
    socket.write(`HTTP/1.1 ${status}\r\nETag: "e"\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
}
