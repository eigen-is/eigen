import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { readSheetsContent } from '../document/sheets';
import { renderSheetsHtml } from '../export/sheets/html';
import type { Mount } from '../mount';
import { renderPreviewTruncatedMarker } from './preview-marker';

export async function generateEigensheetsPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const sheets = await readSheetsContent(mount, drivePath);
    const sheetsHtml = renderSheetsHtml(sheets, 'preview');
    const sanitized = DOMPurify.sanitize(sheetsHtml, { FORCE_BODY: true });
    return sheets.length > 1 ? `${sanitized}${renderPreviewTruncatedMarker()}` : sanitized;
}
