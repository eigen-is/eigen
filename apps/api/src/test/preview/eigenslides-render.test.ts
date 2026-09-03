import { describe, expect, test } from 'bun:test';
import type { DeckData } from '@workspace/lib/slides';
import * as Y from 'yjs';
import { renderEigenslidesPreviewBody } from '../../lib/preview/eigenslides-render';
import { buildGoldenDeck, GOLDEN_MEDIA_NAME, seedSlidesDoc } from '../fixtures/golden-documents';

// The preview body is injected as live DOM by the drive hero and the preview pane. A text object's
// `text` is raw collaborator markup, so the body goes through the shared ref restriction with
// exactly the prepared media URLs allowed through — the image objects and slide backgrounds.
const MEDIA_URL = 'https://api.test/drive/o/m/file/f/preview';
const mediaUrls = new Map([[GOLDEN_MEDIA_NAME, MEDIA_URL]]);

function previewOf(deck: DeckData): string {
    const doc = new Y.Doc();
    seedSlidesDoc(doc, deck);
    const { body } = renderEigenslidesPreviewBody(doc, mediaUrls);
    doc.destroy();
    return body;
}

// The golden deck with every text object carrying the given body.
function previewOfText(html: string): string {
    const deck = buildGoldenDeck();
    for (const object of Object.values(deck.objects)) {
        if (object.type === 'text') object.text = html;
    }
    return previewOf(deck);
}

describe('renderEigenslidesPreviewBody', () => {
    test('an external reference in slide text never reaches a viewer', () => {
        const body = previewOfText(
            '<p style="background:url(https://evil.example/beacon.png)">ok</p>' +
                '<img src="https://evil.example/pixel.png">' +
                '<img srcset="https://evil.example/candidate.png 1x">' +
                '<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>' +
                '<input type="image" src="https://evil.example/i.png">',
        );
        expect(body).toContain('ok');
        expect(body).not.toContain('evil.example');
    });

    test('the prepared media URLs survive as an image object and a slide background', () => {
        const body = previewOf(buildGoldenDeck());
        expect(body).toContain(`<img src="${MEDIA_URL}"`);
        expect(body).toContain(`background-image:url('${MEDIA_URL}')`);
    });
});
