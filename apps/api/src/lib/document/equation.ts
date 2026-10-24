import type { Equation } from '@workspace/lib/docs/eigendoc';
import { readEquation } from '@workspace/lib/docs/eigendoc';
import { parseXml, XmlError } from '../core/xml';

// Bun's parser throws on what the browser's reports in the document: either is no equation.
export function readStoredEquation(attrs: Record<string, unknown>): Equation {
    return readEquation(attrs, (mathml) => {
        try {
            return parseXml(mathml);
        } catch (error) {
            if (error instanceof XmlError) return null;
            throw error;
        }
    });
}
