/**
 * General helper utilities for the dashboard.
 */

// Generate random characters for IDs
export const generateRandomId = (length = 6): string =>
  Math.random()
    .toString(36)
    .replace(/[^a-z0-9]+/g, '')
    .substr(1, length);

// Remove leading slash from a path
export const stripLeadingSlash = (path: string): string => path.replace(/^\//, '');

// Check if string is only slashes
export const isOnlySlashes = (str: string): boolean => /^\/+$/.test(str);

// Download a string as a file
export const downloadTextFile = (name: string, content: string): void => {
  const el = document.createElement('a');
  const blob = new Blob([content], { type: 'text/plain' });
  el.href = URL.createObjectURL(blob);
  el.download = name;
  document.body.appendChild(el);
  el.click();
  document.body.removeChild(el);
};

// Format bytes to human readable - hardcoded values
export const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`;
};

// Truncate text with ellipsis
export const truncate = (text: string, maxLen: number): string => {
  if (text.length <= maxLen) return text;
  return `${text.substring(0, maxLen - 3)}...`;
};
