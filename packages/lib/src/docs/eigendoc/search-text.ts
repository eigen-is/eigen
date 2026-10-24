import type { JSONContent } from '@tiptap/core';
import { chartSearchText, readChartSpec } from '../../charts';
import { isFigureFrameNode, readFigureFrameAttrs } from './nodes/figure-frame';

// What a node shows that no text node holds: a figure's or a chart's caption, and a chart's titles, series and
// categories. A figure's alt text and media name are not shown.
export function attributeSearchText(node: JSONContent): string[] {
    if (!isFigureFrameNode(node.type)) return [];
    const attrs = node.attrs ?? {};
    const { caption } = readFigureFrameAttrs(attrs);
    const chartText = node.type === 'chart' ? chartSearchText(readChartSpec(attrs).spec) : '';
    return [caption ?? '', ...chartText.split('\n')].filter((text) => text !== '');
}
