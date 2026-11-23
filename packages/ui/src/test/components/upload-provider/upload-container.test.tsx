// An upload card's title follows its status: "Uploading" while the file is on its way, and the file name alone once
// it has failed, above the failure line.
import { expect, test } from 'bun:test';
import type { UploadItem } from '../../../components/upload-provider/upload-provider';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { UploadContainer } = await import('../../../components/upload-provider/upload-container');

function cardText(status: UploadItem['status']) {
    const upload: UploadItem = { id: 'u1', filename: 'Budget.xlsx', progress: 40, status };
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(
        createElement(UploadContainer, { uploads: [upload], onCancel: () => {} }),
    );
    return [...container.querySelectorAll('p')].map((line) => line.textContent);
}

test('an upload in flight is titled Uploading with its file name', () => {
    expect(cardText('uploading')).toEqual(['Uploading Budget.xlsx']);
});

test('a failed upload is titled by its file name, above Upload failed', () => {
    expect(cardText('error')).toEqual(['Budget.xlsx', 'Upload failed']);
});
