/** Site matching for autofill: readable items on the server, same rules in the extension. */

export function normalizeHost(value: string): string {
  const host = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "")
    .replace(/^www\./, "");
  if (!host || host.length > 253 || !/^[a-z0-9.-]+$/.test(host)) return "";
  return host;
}

export function rootHost(host: string): string {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const multi = ["co.uk", "com.au", "co.jp", "com.br", "co.nz", "com.tr", "co.za"];
  for (const suffix of multi) {
    if (host.endsWith(`.${suffix}`)) {
      const left = host.slice(0, -(suffix.length + 1));
      const brand = left.split(".").pop();
      return brand ? `${brand}.${suffix}` : host;
    }
  }
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

/** Registrable brand: go.ssbacademy.am → ssbacademy; foo.co.uk → foo. */
export function brandLabel(host: string): string {
  const site = rootHost(normalizeHost(host) || host);
  if (!site) return "";
  return site.split(".")[0] || "";
}

export function hostFromText(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes("@")) return "";
  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const hostname = new URL(withProtocol).hostname;
    if (!hostname.includes(".")) return "";
    return normalizeHost(hostname);
  } catch {
    return "";
  }
}

/**
 * Title/name fuzzy match against the site brand only — never against the TLD
 * or short subdomain labels (those caused name.am to show on every *.am site).
 */
export function nameMatchesHost(value: string, pageHost: string): boolean {
  const brand = brandLabel(pageHost);
  if (brand.length < 2) return false;
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .some(
      (token) =>
        token === brand ||
        (token.length >= 4 && brand.includes(token)) ||
        (brand.length >= 4 && token.includes(brand))
    );
}

/** True when any of these texts (title + non-secret field values) belongs on pageHost. */
export function matchesHost(texts: string[], pageHost: string): boolean {
  const site = rootHost(pageHost);
  if (!site) return false;
  if (texts.some((text) => nameMatchesHost(String(text || ""), pageHost))) return true;
  return texts
    .map((text) => hostFromText(String(text || "")))
    .filter((host): host is string => Boolean(host))
    .some((host) => rootHost(host) === site);
}
