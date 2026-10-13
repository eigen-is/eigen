import { type Equation, readEquation, readEquationLatex } from '@workspace/lib/docs/eigendoc';
import { parseXml, XmlError } from '../core/xml';

// Bun's parser throws on what the browser's reports in the document: either is no equation.
function parseStoredXml(mathml: string) {
    try {
        return parseXml(mathml);
    } catch (error) {
        if (error instanceof XmlError) return null;
        throw error;
    }
}

export function readStoredEquation(attrs: Record<string, unknown>): Equation {
    return readEquation(attrs, parseStoredXml);
}

export function readStoredEquationLatex(attrs: Record<string, unknown>): string | undefined {
    return readEquationLatex(attrs, parseStoredXml);
}
