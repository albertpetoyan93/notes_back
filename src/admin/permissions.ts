import type { StaffRole } from "../models/AdminStaff";

export type Permission =
  | "overview"
  | "overview.revenue"
  | "users.view"
  | "companies.view"
  | "support.actions"
  | "billing.cancel"
  | "billing.manage"
  | "staff.manage"
  | "analytics.view"
  | "marketing.view";

/** Which roles hold each permission. Every admin route is guarded by one of these. */
export const PERMISSIONS: Record<Permission, StaffRole[]> = {
  overview: ["admin", "support", "marketing"],
  "overview.revenue": ["admin"],
  "users.view": ["admin", "support"],
  "companies.view": ["admin", "support"],
  "support.actions": ["admin", "support"],
  "billing.cancel": ["admin", "support"],
  "billing.manage": ["admin"],
  "staff.manage": ["admin"],
  "analytics.view": ["admin", "support", "marketing"],
  "marketing.view": ["admin", "marketing"],
};

export function can(role: StaffRole, permission: Permission): boolean {
  return PERMISSIONS[permission].includes(role);
}

export function permissionsFor(role: StaffRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((permission) => can(role, permission));
}
