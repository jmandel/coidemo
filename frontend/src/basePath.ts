const ROUTE_ROOTS = new Set(['', 'form', 'history', 'submitted']);
let cachedBasePath: string | null = null;

function normalize(path: string): string {
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

export function getBasePath(): string {
  if (cachedBasePath) return cachedBasePath;
  try {
    const segments = window.location.pathname.split('/').filter(Boolean);
    for (let i = 0; i <= segments.length; i++) {
      const remaining = segments.slice(i);
      const first = remaining[0] ?? '';
      if (remaining.length === 0 || ROUTE_ROOTS.has(first)) {
        const baseSegments = segments.slice(0, i);
        cachedBasePath = baseSegments.length ? normalize(baseSegments.join('/')) : '/';
        return cachedBasePath;
      }
    }
  } catch {
    /* ignore */
  }
  cachedBasePath = '/';
  return cachedBasePath;
}

export function withBasePath(relative: string): string {
  const basePath = getBasePath();
  const clean = relative.startsWith('/') ? relative.slice(1) : relative;
  return basePath === '/' ? `/${clean}` : `${basePath}/${clean}`;
}

export function stripBasePath(pathname: string): string {
  const basePath = getBasePath();
  if (basePath === '/' || !pathname.startsWith(basePath)) {
    return pathname.startsWith('/') ? pathname : `/${pathname}`;
  }
  const stripped = pathname.slice(basePath.length);
  return stripped.startsWith('/') ? stripped : `/${stripped}`;
}
