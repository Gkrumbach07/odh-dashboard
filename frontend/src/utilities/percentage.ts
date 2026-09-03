/**
 * Compute what percentage `value` is of `total`, rounded to a whole number.
 */
export const asPercentage = (value: number, total: number): number =>
  Math.round((value / total) * 100);
