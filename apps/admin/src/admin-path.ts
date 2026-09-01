/** Resolves Admin API paths beneath the tenant prefix that served the UI. */
export function adminPath(path: string, pathname = window.location.pathname): string {
  if (!path.startsWith("/admin")) {
    throw new Error("Admin paths must start with /admin");
  }
  const adminIndex = pathname.lastIndexOf("/admin");
  const mountPath = adminIndex >= 0 ? pathname.slice(0, adminIndex) : "";
  return `${mountPath}${path}`;
}
