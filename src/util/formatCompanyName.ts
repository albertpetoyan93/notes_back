export function formatCompanyName(name: string) {
  return name
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
    .join(" ")
    .slice(0, 100);
}
