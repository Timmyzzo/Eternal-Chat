const CACHE_LIMIT = 120;
const completedHtmlCache = new Map<string, string>();

export function getCachedMarkdown(key: string): string | undefined {
  const cached = completedHtmlCache.get(key);
  if (cached === undefined) return undefined;
  completedHtmlCache.delete(key);
  completedHtmlCache.set(key, cached);
  return cached;
}

export function setCachedMarkdown(key: string, value: string): void {
  completedHtmlCache.set(key, value);
  while (completedHtmlCache.size > CACHE_LIMIT) {
    const oldest = completedHtmlCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    completedHtmlCache.delete(oldest);
  }
}

export function clearMarkdownCache(): void {
  completedHtmlCache.clear();
}

export function markdownCacheSize(): number {
  return completedHtmlCache.size;
}
