import { Router, RequestHandler } from "express";
import isAuth from "../middlwares/isAuth";
import CompanyController from "../controller/CompanyController";

const router = Router();

router.use(isAuth);
router.get("/", CompanyController.list as RequestHandler);
router.post("/", CompanyController.create as RequestHandler);
router.put("/:id", CompanyController.rename as RequestHandler);
router.get("/:id/collections", CompanyController.collections as RequestHandler);
router.post("/:id/collections", CompanyController.createCollection as RequestHandler);
router.post("/:id/collections/:collectionId/share", CompanyController.shareCollection as RequestHandler);
router.delete(
  "/:id/collections/:collectionId/share",
  CompanyController.unshareCollection as RequestHandler
);
router.get("/:id/members", CompanyController.members as RequestHandler);
router.put("/:id/members/:memberId", CompanyController.updateMember as RequestHandler);
router.delete("/:id/members/:memberId", CompanyController.removeMember as RequestHandler);
router.post("/:id/invites", CompanyController.invite as RequestHandler);
router.post("/:id/accept", CompanyController.accept as RequestHandler);
router.post("/:id/decline", CompanyController.decline as RequestHandler);

export default router;
