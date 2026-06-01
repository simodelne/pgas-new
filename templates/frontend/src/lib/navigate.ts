// Hash-router navigation helper. Lives in lib/ (not next to Router.tsx)
// so it can be imported by both the router and the pages without
// tripping eslint-plugin-react-refresh's "only export components" rule.

export function navigate(path: string): void {
  window.location.hash = path.startsWith('#') ? path : `#${path}`;
}
