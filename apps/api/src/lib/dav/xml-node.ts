// fast-xml-parser returns `any`; every DAV body reader narrows its nodes through these instead of casting.
export type XmlNode = Record<string, unknown>;

export const isXmlNode = (v: unknown): v is XmlNode => typeof v === 'object' && v !== null && !Array.isArray(v);

// A missing or scalar child reads as an empty node so lookups chain without null checks.
export const asNode = (v: unknown): XmlNode => (isXmlNode(v) ? v : {});

// fast-xml-parser collapses a single repeated child to the value itself, so a filter grammar's `*` or `?` child reads through this.
export const asArray = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// i;ascii-casemap (RFC 4790 § 9.2) folds A–Z only, so an accented letter keeps its case.
export const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
