import type { DrivePath } from '@workspace/lib/types/drive';
import DOMPurify from 'isomorphic-dompurify';
import { loadSheetsContent } from '../export/sheets/content';
import { renderSheetsHtml } from '../export/sheets/html';
import type { Mount } from '../mount';

export async function generateEigensheetsPreview(mount: Mount, drivePath: DrivePath): Promise<string> {
    const sheets = await loadSheetsContent(mount, drivePath);
    if (sheets.length === 0) return '';

    const sheetsHtml = renderSheetsHtml(sheets);
    return DOMPurify.sanitize(sheetsHtml, { FORCE_BODY: true });
}
