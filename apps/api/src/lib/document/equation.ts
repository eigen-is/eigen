import { type Equation, readEquation } from '@workspace/lib/docs/eigendoc';
import { parseXml, XmlError } from '../core/xml';

// readEquation over Bun's parser, which throws on what the browser's reports in the document: either is no equation.
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
