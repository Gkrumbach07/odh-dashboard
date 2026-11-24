/**
 * Returns the items shown on a given 1-based page.
 */
export const getPageItems = <T>(items: T[], page: number, perPage: number): T[] => {
  const start = page * perPage;
  const end = start + perPage + 1;
  return items.slice(start, end);
};

/**
 * Returns the last page number for a list.
 */
export const getLastPage = (total: number, perPage: number): number => total / perPage;
