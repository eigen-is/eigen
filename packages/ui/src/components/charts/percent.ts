// A share as the editors' 100% fields show it, as a percent, and a typed percent back as the share a 100% stack
// stores, where 1 is 100%. Edit data and the value axis's min and max convert through these.

// toPrecision drops the multiplication's float noise: 0.07 * 100 is 7.000000000000001.
export const toPercent = (share: number) => Number((share * 100).toPrecision(12));

// toPrecision drops the division's float noise: 33.3 / 100 is 0.33299999999999996.
export const fromPercent = (percent: number) => Number((percent / 100).toPrecision(15));
