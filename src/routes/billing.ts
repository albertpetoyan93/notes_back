import { RequestHandler, Router } from "express";
import isAuth from "../middlwares/isAuth";
import BillingController from "@src/controller/BillingController";

const router = Router();

router.use(isAuth);

// Plan, limits, trials, and payments with Stripe. (The Stripe webhook is mounted in
// server.ts, before JSON parsing: its signature is checked against the raw body.)
router.get("/", BillingController.summary as RequestHandler);
router.post("/trial", BillingController.startTrial as RequestHandler);
router.post("/checkout", BillingController.checkout as RequestHandler);
router.post("/portal", BillingController.portal as RequestHandler);
router.post("/cancel", BillingController.cancel as RequestHandler);
router.post("/resume", BillingController.resume as RequestHandler);
router.post("/interval", BillingController.changeInterval as RequestHandler);
router.post("/companies/:id/discount", BillingController.requestDiscount as RequestHandler);

// Family: the organizer invites up to 5 people; each keeps a private vault.
router.post("/family/invites", BillingController.familyInvite as RequestHandler);
router.post("/family/invites/:id/accept", BillingController.familyAccept as RequestHandler);
router.post("/family/invites/:id/decline", BillingController.familyDecline as RequestHandler);
router.delete("/family/members/:id", BillingController.familyRemove as RequestHandler);
router.post("/family/leave", BillingController.familyLeave as RequestHandler);
router.post("/family/collection", BillingController.familyCollection as RequestHandler);

export default router;
