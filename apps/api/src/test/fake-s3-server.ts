import * as net from 'node:net';
import type { S3Config } from '@workspace/lib/types';
import type { StorageBackend } from '../lib/storage';

// A local S3 for the real S3Storage: faults on the lazy S3File's HEAD, GET and DELETE, which FaultStorage never sees.

// stall-body: headers and half the body, then silence; cut: half, then close; fail-get: a 500 on GET only.
// HEAD and DELETE honor only stall and fail.
export type S3Fault = 'stall' | 'stall-body' | 'cut' | 'empty' | 'fail' | 'fail-get';

export class FakeS3Server {
    // Keyed by object key.
    readonly faults = new Map<string, S3Fault>();
    readonly gets = new Map<string, number>();
    // Held requests whose client closed the connection itself.
    abandoned = 0;
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
        return {
            endpoint: `http://127.0.0.1:${port}`,
            bucket: 'eigen',
            accessKeyId: 'x',
            secretAccessKey: 'y',
            region: 'us-east-1',
            prefix: '',
        };
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
        const key = decodeURIComponent(new URL(target, 'http://s3').pathname.split('/').slice(2).join('/'));
        if (method === 'PUT') {
            await this.store.write(key, new Uint8Array(body));
            reply(socket, method, '200 OK');
            return;
        }
        if (method === 'GET') this.gets.set(key, (this.gets.get(key) ?? 0) + 1);
        const fault = this.faults.get(key);
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
        if (method === 'DELETE') {
            await this.store.delete(key);
            reply(socket, method, '204 No Content');
            return;
        }
        const size = await this.store.size(key);
        if (size === null) {
            reply(socket, method, '404 Not Found', 'NoSuchKey');
            return;
        }
        if (method === 'HEAD') {
            socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${size}\r\nETag: "e"\r\n\r\n`);
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
        if (fault === undefined) {
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
}

function reply(socket: net.Socket, method: string, status: string, code?: string): void {
    const payload = code && method !== 'HEAD' ? `<Error><Code>${code}</Code></Error>` : '';
    socket.write(`HTTP/1.1 ${status}\r\nETag: "e"\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`);
}
