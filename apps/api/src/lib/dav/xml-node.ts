// fast-xml-parser returns `any`; every DAV body reader narrows its nodes through these instead of casting.
export type XmlNode = Record<string, unknown>;

export const isXmlNode = (v: unknown): v is XmlNode => typeof v === 'object' && v !== null && !Array.isArray(v);

// A missing or scalar child reads as an empty node so lookups chain without null checks.
export const asNode = (v: unknown): XmlNode => (isXmlNode(v) ? v : {});
