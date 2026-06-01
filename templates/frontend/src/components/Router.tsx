// Minimal hash-based router. The plugin v0.1 scaffold deliberately
// avoids react-router so consumers can pick their own routing later
// without un-vendoring a dependency.
//
// Routes are defined as an array of `{ pattern, render }`. The first
// match wins. `:param` captures get passed to the renderer.

import { useEffect, useState, type ReactNode } from 'react';

export interface RouteDef {
  pattern: string;
  render: (params: Record<string, string>) => ReactNode;
}

function readPath(): string {
  const h = window.location.hash || '#/';
  return h.startsWith('#') ? h.slice(1) : h;
}

function match(pattern: string, path: string): Record<string, string> | null {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    const p = patternParts[i];
    const v = pathParts[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(v);
    } else if (p !== v) {
      return null;
    }
  }
  return params;
}

export function Router({ routes, fallback }: { routes: RouteDef[]; fallback: ReactNode }) {
  const [path, setPath] = useState(readPath);
  useEffect(() => {
    const handler = () => setPath(readPath());
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, []);

  for (const route of routes) {
    const params = match(route.pattern, path);
    if (params) return <>{route.render(params)}</>;
  }
  return <>{fallback}</>;
}
