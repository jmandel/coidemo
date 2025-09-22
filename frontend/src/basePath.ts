const ROUTE_SEGMENTS = new Set(['form', 'history', 'submitted']);
let cachedBasePath: string | null = null;

function normalize(path: string): string {
  if (!path.startsWith('/')) path = `/${path}`;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path || '/';
}

function computeBasePath(): string {
  try {
    const segments = window.location.pathname.split('/').filter(Boolean);
    while (segments.length > 0 && ROUTE_SEGMENTS.has(segments[segments.length - 1])) {
      segments.pop();
    }
    const base = segments.join('/');
    return base ? normalize(base) : '/';
  } catch {
    return '/';
  }
}

export function getBasePath(): string {
  if (!cachedBasePath) {
    cachedBasePath = computeBasePath();
  }
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
