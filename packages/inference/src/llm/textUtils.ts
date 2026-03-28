export function truncateText(content: string, maxLength: number, suffix: string): string {
  if (content.length <= maxLength) return content;
  return content.slice(0, maxLength) + suffix;
}

export function truncateOptionalText(
  content: string | null | undefined,
  maxLength: number,
  fallback: string,
  suffix: string,
): string {
  if (!content) return fallback;
  return truncateText(content, maxLength, suffix);
}
