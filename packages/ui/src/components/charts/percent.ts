// toPrecision drops the division's float noise: 33.3 / 100 is 0.33299999999999996.
export const fromPercent = (percent: number) => Number((percent / 100).toPrecision(15));
