import pathlib from 'node:path';
import { PassThrough, type Transform } from 'node:stream';
import libbase64 from 'libbase64';
import libmime from 'libmime';
import libqp from 'libqp';
import Headers from './headers';

type MimeNodeConfig = {
    Iconv?: unknown;
};

type ParsedHeaderValue = {
    value: string;
    params: Record<string, string>;
};

type PartNrSegment = number | string;

class MimeNode {
    type: string;
    root: boolean;
    parentNode: MimeNode | null;

    _parentBoundary: Buffer | null;
    _headersLines: Buffer[];
    _headerlen: number;

    _parsedContentType: ParsedHeaderValue;
    _parsedContentDisposition: ParsedHeaderValue;
    _boundary: Buffer | null;

    multipart: string | null;
    encoding: string;
    headers: Headers | null;
    contentType: string | null;
    charset: string | null;
    disposition: string | null;
    flowed: boolean;
    delSp: boolean;
    filename: string | null;
    rfc822: boolean;
    messageNode?: boolean;

    config: MimeNodeConfig;
    libmime: InstanceType<typeof libmime.Libmime>;

    parentPartNumber: PartNrSegment[];
    partNr: PartNrSegment[] | null;
    childPartNumbers: number;

    constructor(parentNode: MimeNode | null, config?: MimeNodeConfig) {
        this.type = 'node';
        this.root = !parentNode;
        this.parentNode = parentNode;

        this._parentBoundary = this.parentNode?._boundary ?? null;
        this._headersLines = [];
        this._headerlen = 0;

        this._parsedContentType = { value: '', params: {} };
        this._parsedContentDisposition = { value: '', params: {} };
        this._boundary = null;

        this.multipart = null;
        this.encoding = '';
        this.headers = null;
        this.contentType = null;
        this.charset = null;
        this.disposition = null;
        this.flowed = false;
        this.delSp = false;
        this.filename = null;
        this.rfc822 = false;

        this.config = config || {};
        this.libmime = new libmime.Libmime({ Iconv: this.config.Iconv });

        this.partNr = null;
        this.parentPartNumber = parentNode?.partNr || [];
        this.childPartNumbers = 0;
    }

    private getPartNr(provided?: string): PartNrSegment[] {
        if (provided) {
            return ([] as PartNrSegment[])
                .concat(this.partNr || [])
                .filter((nr) => (typeof nr === 'number' ? !Number.isNaN(nr) : true))
                .concat(provided);
        }
        const childPartNr = ++this.childPartNumbers;
        return ([] as PartNrSegment[])
            .concat(this.partNr || [])
            .filter((nr) => (typeof nr === 'number' ? !Number.isNaN(nr) : true))
            .concat(childPartNr);
    }

    addHeaderChunk(line: Buffer): void {
        if (!line) {
            return;
        }
        this._headersLines.push(line);
        this._headerlen += line.length;
    }

    parseHeaders(): void {
        if (this.headers) {
            return;
        }
        this.headers = new Headers(Buffer.concat(this._headersLines, this._headerlen), this.config);

        const params = this.headers.getFirst('Content-Disposition');
        this._parsedContentDisposition = this.libmime.parseHeaderValue(params) as ParsedHeaderValue;

        const dispParams = this._parsedContentDisposition.params;

        let contentHeader: string | undefined;
        if (this.headers.get('Content-Type').length) {
            contentHeader = this.headers.getFirst('Content-Type');
        } else {
            if (dispParams['filename']) {
                const extension = pathlib.parse(dispParams['filename']).ext.replace(/^\./, '');
                if (extension) {
                    contentHeader = libmime.detectMimeType(extension);
                }
            }
            if (!contentHeader) {
                if (/^attachment$/i.test(this._parsedContentDisposition.value)) {
                    contentHeader = 'application/octet-stream';
                } else {
                    contentHeader = 'text/plain';
                }
            }
        }

        this._parsedContentType = this.libmime.parseHeaderValue(contentHeader) as ParsedHeaderValue;

        const ctParams = this._parsedContentType.params;

        this.encoding = this.headers
            .getFirst('Content-Transfer-Encoding')
            .replace(/\(.*\)/g, '')
            .toLowerCase()
            .trim();
        this.contentType = (this._parsedContentType.value || '').toLowerCase().trim() || null;
        this.charset = ctParams['charset'] || null;
        this.disposition = (this._parsedContentDisposition.value || '').toLowerCase().trim() || null;

        if (this.disposition) {
            try {
                this.disposition = this.libmime.decodeWords(this.disposition);
            } catch (_e) {
                // failed to parse disposition, keep as is
            }
        }

        this.filename = dispParams['filename'] || ctParams['name'] || null;

        if (ctParams['format'] && ctParams['format'].toLowerCase().trim() === 'flowed') {
            this.flowed = true;
            if (ctParams['delsp'] && ctParams['delsp'].toLowerCase().trim() === 'yes') {
                this.delSp = true;
            }
        }

        if (this.filename) {
            try {
                this.filename = this.libmime.decodeWords(this.filename);
            } catch (_e) {
                // failed to parse filename, keep as is
            }
        }

        this.multipart =
            (this.contentType &&
                this.contentType.slice(0, this.contentType.indexOf('/')) === 'multipart' &&
                this.contentType.slice(this.contentType.indexOf('/') + 1)) ||
            null;
        this._boundary = ctParams['boundary'] ? Buffer.from(ctParams['boundary']) : null;

        this.rfc822 = this.contentType === 'message/rfc822';

        if (!this.parentNode || this.parentNode.rfc822) {
            this.partNr = this.parentNode ? this.parentNode.getPartNr('TEXT') : ['TEXT'];
        } else {
            this.partNr = this.parentNode ? this.parentNode.getPartNr() : [];
        }
    }

    getHeaders(): Buffer {
        if (!this.headers) {
            this.parseHeaders();
        }
        return (this.headers as Headers).build();
    }

    setContentType(contentType?: string): void {
        if (!this.headers) {
            this.parseHeaders();
        }

        contentType = (contentType || '').toLowerCase().trim();
        if (contentType) {
            this._parsedContentType.value = contentType;
        }

        const ctParams = this._parsedContentType.params;
        if (!this.flowed && ctParams['format']) {
            delete ctParams['format'];
        }

        if (!this.delSp && ctParams['delsp']) {
            delete ctParams['delsp'];
        }

        (this.headers as Headers).update('Content-Type', this.libmime.buildHeaderValue(this._parsedContentType));
    }

    getDecoder(): Transform | PassThrough {
        if (!this.headers) {
            this.parseHeaders();
        }

        switch (this.encoding) {
            case 'base64':
                return new libbase64.Decoder();
            case 'quoted-printable':
                return new libqp.Decoder();
            default:
                return new PassThrough();
        }
    }

    getEncoder(encoding?: string): Transform | PassThrough {
        if (!this.headers) {
            this.parseHeaders();
        }

        encoding = (encoding || '').toString().toLowerCase().trim();

        if (encoding && encoding !== this.encoding) {
            (this.headers as Headers).update('Content-Transfer-Encoding', encoding);
        } else {
            encoding = this.encoding;
        }

        switch (encoding) {
            case 'base64':
                return new libbase64.Encoder();
            case 'quoted-printable':
                return new libqp.Encoder();
            default:
                return new PassThrough();
        }
    }
}

export default MimeNode;
