import { RequestHandler, Router } from "express";
import isAuth from "../middlwares/isAuth";
import EmergencyController from "@src/controller/EmergencyController";

const router = Router();

router.use(isAuth);

// Emergency access: both sides on one page.
router.get("/", EmergencyController.summary as RequestHandler);

// The owner: trusted contacts.
router.post("/", EmergencyController.invite as RequestHandler);
router.put("/:id", EmergencyController.setWait as RequestHandler);
router.post("/:id/confirm", EmergencyController.confirm as RequestHandler);
router.post("/:id/approve", EmergencyController.approve as RequestHandler);
router.post("/:id/refuse", EmergencyController.refuse as RequestHandler);
router.delete("/:id", EmergencyController.remove as RequestHandler);

// The contact: people who trust them.
router.post("/:id/accept", EmergencyController.accept as RequestHandler);
router.post("/:id/leave", EmergencyController.leave as RequestHandler);
router.post("/:id/request", EmergencyController.request as RequestHandler);
router.get("/:id/vault", EmergencyController.vault as RequestHandler);

export default router;
