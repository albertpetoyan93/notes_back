import { RequestHandler, Router } from "express";
import isAuth from "../middlwares/isAuth";
import isAdmin from "../middlwares/isAdmin";
import AdminController from "@src/controller/AdminController";

const router = Router();

router.use(isAuth, isAdmin);

router.get("/overview", AdminController.overview as RequestHandler);
router.post("/discounts/:id/approve", AdminController.approveDiscount as RequestHandler);
router.post("/discounts/:id/decline", AdminController.declineDiscount as RequestHandler);
router.delete("/companies/:id/discount", AdminController.removeDiscount as RequestHandler);

export default router;
