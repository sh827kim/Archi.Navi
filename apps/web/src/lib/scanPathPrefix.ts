export function isAbsoluteScanPathPrefix(prefix: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(prefix);
}
