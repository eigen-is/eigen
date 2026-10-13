import { type Equation, equationText, readEquation } from '@workspace/lib/docs/eigendoc';
import type { MathXmlElement } from '@workspace/math';
import { parseXml, XmlError } from '../core/xml';

// Bun's parser throws on what the browser's reports in the document: either is no equation.
function parseStored(mathml: string): MathXmlElement | null {
    try {
        return parseXml(mathml);
    } catch (error) {
        if (error instanceof XmlError) return null;
        throw error;
    }
}

export const readStoredEquation = (attrs: Record<string, unknown>): Equation => readEquation(attrs, parseStored);

export const storedEquationText = (attrs: Record<string, unknown>): string => equationText(attrs, parseStored);
