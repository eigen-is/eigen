import libmime from 'libmime';

type HeaderLine = {
    key: string;
    line: string;
};

type HeaderConfig = {
    Iconv?: unknown;
};

class Headers {
    changed: boolean;
    headers: string | Buffer | null;
    parsed: boolean;
    lines: HeaderLine[];
    mbox: string | null;
    http: string | null;
    libmime: InstanceType<typeof libmime.Libmime>;

    constructor(headers: HeaderLine[] | string | Buffer, config?: HeaderConfig) {
        const cfg = config || {};

        if (Array.isArray(headers)) {
            this.changed = true;
            this.headers = null;
            this.parsed = true;
            this.lines = headers;
        } else {
            this.changed = false;
            this.headers = headers;
            this.parsed = false;
            this.lines = [];
        }
        this.mbox = null;
        this.http = null;

        this.libmime = new libmime.Libmime({ Iconv: cfg.Iconv });
    }

    get(key: string): string[] {
        if (!this.parsed) {
            this._parseHeaders();
        }
        key = this._normalizeHeader(key);
        const lines = this.lines.filter((line) => line.key === key).map((line) => line.line);

        return lines;
    }

    getFirst(key: string): string {
        if (!this.parsed) {
            this._parseHeaders();
        }
        key = this._normalizeHeader(key);
        const header = this.lines.find((line) => line.key === key);
        if (!header) {
            return '';
        }
        return ((this.libmime.decodeHeader(header.line) as { value?: string } | null)?.value || '').toString().trim();
    }

    getList(): HeaderLine[] {
        if (!this.parsed) {
            this._parseHeaders();
        }
        return this.lines;
    }

    private add(key: string, value: string | number | Buffer | undefined, index?: number): void {
        if (typeof value === 'undefined') {
            return;
        }

        let strValue: string;
        if (typeof value === 'number') {
            strValue = value.toString();
        } else if (typeof value === 'string') {
            strValue = Buffer.from(value).toString('binary');
        } else {
            strValue = value.toString('binary');
        }

        this.addFormatted(key, this.libmime.foldLines(`${key}: ${strValue.replace(/\r?\n/g, '')}`, 76, false), index);
    }

    private addFormatted(key: string, line: string | Buffer | undefined, index?: number): void {
        if (!this.parsed) {
            this._parseHeaders();
        }
        index = index || 0;
        this.changed = true;

        if (!line) {
            return;
        }

        let lineStr: string;
        if (typeof line !== 'string') {
            lineStr = line.toString('binary');
        } else {
            lineStr = line;
        }

        const header: HeaderLine = {
            key: this._normalizeHeader(key),
            line: lineStr,
        };

        if (index < 1) {
            this.lines.unshift(header);
        } else if (index >= this.lines.length) {
            this.lines.push(header);
        } else {
            this.lines.splice(index, 0, header);
        }
    }

    update(key: string, value: string | number | Buffer | undefined, relativeIndex?: number): void {
        if (!this.parsed) {
            this._parseHeaders();
        }
        const keyName = key;
        let index = 0;
        key = this._normalizeHeader(key);
        let relativeIndexCount = 0;
        let relativeMatchFound = false;
        for (let i = this.lines.length - 1; i >= 0; i--) {
            if (this.lines[i].key === key) {
                if (relativeIndex && relativeIndex !== relativeIndexCount) {
                    relativeIndexCount++;
                    continue;
                }
                index = i;
                this.changed = true;
                this.lines.splice(i, 1);
                if (relativeIndex) {
                    relativeMatchFound = true;
                    break;
                }
            }
        }
        if (relativeIndex && !relativeMatchFound) return;
        this.add(keyName, value, index);
    }

    build(lineEnd?: string): Buffer {
        if (!this.changed && !lineEnd) {
            return typeof this.headers === 'string'
                ? Buffer.from(this.headers, 'binary')
                : this.headers || Buffer.alloc(0);
        }

        if (!this.parsed) {
            this._parseHeaders();
        }

        lineEnd = lineEnd || '\r\n';

        let headers = `${this.lines.map((line) => line.line.replace(/\r?\n/g, lineEnd!)).join(lineEnd)}${lineEnd}${lineEnd}`;

        if (this.mbox) {
            headers = this.mbox + lineEnd + headers;
        }

        if (this.http) {
            headers = this.http + lineEnd + headers;
        }

        return Buffer.from(headers, 'binary');
    }

    private _normalizeHeader(key: string): string {
        return (key || '').toLowerCase().trim();
    }

    private _parseHeaders(): void {
        if (!this.headers) {
            this.lines = [];
            this.parsed = true;
            return;
        }

        const rawLines = this.headers
            .toString('binary')
            .replace(/[\r\n]+$/, '')
            .split(/\r?\n/);

        const result: (string | HeaderLine)[] = [...rawLines];

        for (let i = result.length - 1; i >= 0; i--) {
            const entry = result[i] as string;
            const chr = entry.charAt(0);
            if (i && (chr === ' ' || chr === '\t')) {
                result[i - 1] = `${result[i - 1] as string}\r\n${entry}`;
                result.splice(i, 1);
            } else {
                const line = entry;
                if (!i && /^From /i.test(line)) {
                    this.mbox = line;
                    result.splice(i, 1);
                    continue;
                } else if (!i && /^POST /i.test(line)) {
                    this.http = line;
                    result.splice(i, 1);
                    continue;
                }
                const key = this._normalizeHeader(line.slice(0, line.indexOf(':')));
                result[i] = {
                    key,
                    line,
                };
            }
        }

        this.lines = result as HeaderLine[];
        this.parsed = true;
    }
}

export default Headers;
