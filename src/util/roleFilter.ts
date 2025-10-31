/**
 * Returns an object with role-based filters for ExternalUser queries.
 * @param role The user's role (e.g., 'admin', 'manager', 'limited', etc.)
 */
export function getRoleBasedFilterExternalUser(role: string) {
  // Always exclude status_login = 'google'
  const filter: any = {};

  switch (role) {
    case "limited":
      filter.demo = "N";
      filter.testing = "Y";
      filter.active = "Y";
      break;
    case "admin":
      // No extra filter for admin
      break;
    case "manager":
      filter.demo = "N";
      filter.testing = "N";
      break;
    default:
      filter.demo = "N";
      filter.testing = "N";
      filter.active = "Y";
      break;
  }

  return filter;
}
