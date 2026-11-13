// Holds the Drive upload an editor sends until the test answers it, with the picture the server would make under the
// name the test gives. The upload goes by XHR, which a fetch stub never sees, so this stands in for the request and
// leaves the rest of the upload path, such as the media resolver's swap of the pending name, real.

import type { DrivePath } from '@workspace/lib/types/drive';

// Call after happy-dom is installed: the stand-in extends its XMLHttpRequest.
export function answerUploads(path: DrivePath): (name: string) => void {
    let answer = (_name: string) => {};
    class AnsweredUpload extends XMLHttpRequest {
        public override status = 0;
        public override responseText = '';

        public override send() {
            answer = (name) => {
                this.status = 200;
                this.responseText = JSON.stringify([
                    { ...path, id: name, name, parentId: 'media', mimeType: 'image/png' },
                ]);
                this.onload?.call(this, new ProgressEvent('load'));
            };
        }

        public override getResponseHeader() {
            return 'application/json';
        }
    }
    globalThis.XMLHttpRequest = AnsweredUpload;
    return (name) => answer(name);
}
