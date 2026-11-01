import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import CompanyController from "../controller/CompanyController";
import CompanyRecoveryController from "../controller/CompanyRecoveryController";
import GroupController from "../controller/GroupController";

const router = Router();

router.use(isAuth);
router.get("/", CompanyController.list as RequestHandler);
router.post("/", CompanyController.create as RequestHandler);
// Admin recovery: background work for this person's browser (before "/:id").
router.get("/recovery/tasks", CompanyRecoveryController.tasks as RequestHandler);
router.post("/recovery/enroll", CompanyRecoveryController.enroll as RequestHandler);
router.post("/recovery/grant", CompanyRecoveryController.grant as RequestHandler);
router.post("/recovery/rotate", CompanyRecoveryController.rotate as RequestHandler);
router.put("/:id", CompanyController.rename as RequestHandler);
// Admin recovery for one company: status, on/off (owner), resetting a member (owners and admins).
router.get("/:id/recovery", CompanyRecoveryController.status as RequestHandler);
router.post("/:id/recovery/enable", CompanyRecoveryController.enable as RequestHandler);
router.post("/:id/recovery/disable", CompanyRecoveryController.disable as RequestHandler);
router.get("/:id/recovery/members/:userId", CompanyRecoveryController.memberKeys as RequestHandler);
router.post("/:id/recovery/members/:userId", CompanyRecoveryController.reset as RequestHandler);
// Security policies: owners and admins.
router.get("/:id/policies", CompanyController.policies as RequestHandler);
router.put("/:id/policies", CompanyController.updatePolicies as RequestHandler);
router.get("/:id/collections", CompanyController.collections as RequestHandler);
router.post("/:id/collections", CompanyController.createCollection as RequestHandler);
router.post("/:id/collections/:collectionId/share", CompanyController.shareCollection as RequestHandler);
router.delete(
  "/:id/collections/:collectionId/share",
  CompanyController.unshareCollection as RequestHandler
);
// Groups: owners and admins manage them; members see them and can ask to join.
router.get("/:id/groups", GroupController.list as RequestHandler);
router.post("/:id/groups", GroupController.create as RequestHandler);
router.put("/:id/groups/:groupId", GroupController.rename as RequestHandler);
router.delete("/:id/groups/:groupId", GroupController.remove as RequestHandler);
router.post("/:id/groups/:groupId/members", GroupController.addMembers as RequestHandler);
router.delete("/:id/groups/:groupId/members/:userId", GroupController.removeMember as RequestHandler);
router.post("/:id/groups/:groupId/request", GroupController.request as RequestHandler);
router.delete("/:id/groups/:groupId/request", GroupController.cancelRequest as RequestHandler);
router.post("/:id/group-requests/:requestId/approve", GroupController.decide(true) as RequestHandler);
router.post("/:id/group-requests/:requestId/decline", GroupController.decide(false) as RequestHandler);
router.post("/:id/collections/:collectionId/groups", GroupController.shareCollection as RequestHandler);
router.delete("/:id/collections/:collectionId/groups/:groupId", GroupController.unshareCollection as RequestHandler);
// The owner can always take the company's items out (also while suspended).
router.get("/:id/export", CompanyController.exportItems as RequestHandler);
router.get("/:id/members", CompanyController.members as RequestHandler);
router.get("/:id/activity", CompanyController.activity as RequestHandler);
router.get(
  "/:id/members/:memberId/access",
  CompanyController.memberAccess as RequestHandler
);
router.put("/:id/members/:memberId", CompanyController.updateMember as RequestHandler);
router.delete("/:id/members/:memberId", CompanyController.removeMember as RequestHandler);
router.post("/:id/invites", CompanyController.invite as RequestHandler);
router.post("/:id/accept", CompanyController.accept as RequestHandler);
router.post("/:id/decline", CompanyController.decline as RequestHandler);

export default router;
