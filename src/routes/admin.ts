import { RequestHandler, Router } from "express";
import type { Permission } from "@src/admin/permissions";
import AdminController from "@src/controller/AdminController";
import isStaff from "@src/middlwares/isStaff";
import requireStaff from "@src/middlwares/requireStaff";
import adminAuth from "./adminAuth";

export const ADMIN_ROUTES: {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  permission: Permission;
  handler: RequestHandler;
}[] = [
  { method: "get", path: "/overview", permission: "overview", handler: AdminController.overview as RequestHandler },
  {
    method: "get",
    path: "/analytics/daily",
    permission: "analytics.view",
    handler: AdminController.analyticsDaily as RequestHandler,
  },
  {
    method: "get",
    path: "/analytics/funnel",
    permission: "analytics.view",
    handler: AdminController.analyticsFunnel as RequestHandler,
  },
  {
    method: "get",
    path: "/analytics/retention",
    permission: "analytics.view",
    handler: AdminController.analyticsRetention as RequestHandler,
  },
  {
    method: "get",
    path: "/analytics/extension-versions",
    permission: "analytics.view",
    handler: AdminController.analyticsExtensionVersions as RequestHandler,
  },
  {
    method: "get",
    path: "/marketing/signups",
    permission: "marketing.view",
    handler: AdminController.marketingSignups as RequestHandler,
  },
  { method: "get", path: "/users", permission: "users.view", handler: AdminController.listUsers as RequestHandler },
  { method: "get", path: "/users/:id", permission: "users.view", handler: AdminController.getUser as RequestHandler },
  {
    method: "post",
    path: "/users/:id/password-reset",
    permission: "support.actions",
    handler: AdminController.passwordReset as RequestHandler,
  },
  {
    method: "post",
    path: "/users/:id/sign-out-all",
    permission: "support.actions",
    handler: AdminController.signOutAll as RequestHandler,
  },
  {
    method: "post",
    path: "/users/:id/suspend",
    permission: "support.actions",
    handler: AdminController.suspend as RequestHandler,
  },
  {
    method: "post",
    path: "/users/:id/unsuspend",
    permission: "support.actions",
    handler: AdminController.unsuspend as RequestHandler,
  },
  {
    method: "post",
    path: "/users/:id/2fa-removal",
    permission: "support.actions",
    handler: AdminController.requestTwoFactorRemoval as RequestHandler,
  },
  {
    method: "delete",
    path: "/support-requests/:id",
    permission: "support.actions",
    handler: AdminController.cancelSupportRequest as RequestHandler,
  },
  {
    method: "get",
    path: "/companies",
    permission: "companies.view",
    handler: AdminController.listCompanies as RequestHandler,
  },
  {
    method: "get",
    path: "/companies/:id",
    permission: "companies.view",
    handler: AdminController.getCompany as RequestHandler,
  },
  {
    method: "post",
    path: "/companies/:id/transfer-ownership",
    permission: "support.actions",
    handler: AdminController.transferOwnership as RequestHandler,
  },
  {
    method: "post",
    path: "/subscriptions/:id/cancel",
    permission: "billing.cancel",
    handler: AdminController.cancelSubscription as RequestHandler,
  },
  {
    method: "get",
    path: "/subscriptions/:id/payments",
    permission: "billing.manage",
    handler: AdminController.listPayments as RequestHandler,
  },
  {
    method: "post",
    path: "/subscriptions/:id/refund",
    permission: "billing.manage",
    handler: AdminController.refund as RequestHandler,
  },
  {
    method: "post",
    path: "/subscriptions/:id/plan",
    permission: "billing.manage",
    handler: AdminController.changePlan as RequestHandler,
  },
  {
    method: "post",
    path: "/subscriptions/:id/extend-trial",
    permission: "billing.manage",
    handler: AdminController.extendTrial as RequestHandler,
  },
  {
    method: "post",
    path: "/discounts/:id/approve",
    permission: "billing.manage",
    handler: AdminController.approveDiscount as RequestHandler,
  },
  {
    method: "post",
    path: "/discounts/:id/decline",
    permission: "billing.manage",
    handler: AdminController.declineDiscount as RequestHandler,
  },
  {
    method: "delete",
    path: "/companies/:id/discount",
    permission: "billing.manage",
    handler: AdminController.removeDiscount as RequestHandler,
  },
  { method: "get", path: "/staff", permission: "staff.manage", handler: AdminController.listStaff as RequestHandler },
  { method: "post", path: "/staff", permission: "staff.manage", handler: AdminController.addStaff as RequestHandler },
  {
    method: "patch",
    path: "/staff/:userId",
    permission: "staff.manage",
    handler: AdminController.updateStaff as RequestHandler,
  },
  {
    method: "get",
    path: "/actions",
    permission: "staff.manage",
    handler: AdminController.listActions as RequestHandler,
  },
];

const router = Router();

router.use("/auth", adminAuth);
router.use(isStaff);
for (const route of ADMIN_ROUTES) {
  router[route.method](route.path, requireStaff(route.permission), route.handler);
}

export default router;
