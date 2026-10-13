import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The equations of LibreOffice's (MPL-2.0) and docx4j's (Apache-2.0) test documents: `i` is the corpus index, `file`
// the source document, `omml` one m:oMath with w:rFonts stripped.
export type CorpusEquation = { i: number; file: string; display: boolean; omml: string };

export const CORPUS: CorpusEquation[] = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures/omml-corpus.json'), 'utf8'),
);
