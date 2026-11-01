/** Accepts short semver-like builds from the extension; anything else is ignored. */
export function parseExtensionVersion(raw: string | undefined | null): string | null {
  if (raw == null) return null;
  const v = String(raw).trim();
  if (!v || v.length > 32) return null;
  if (!/^\d{1,3}(\.\d{1,3}){1,3}$/.test(v)) return null;
  return v;
}
