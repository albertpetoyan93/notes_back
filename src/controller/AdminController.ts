import { Response } from "express";
import AdminService from "../services/AdminService";
import { BillingError } from "../services/BillingService";
import DiscountService from "../services/DiscountService";

async function respond(res: Response, fallback: string, run: () => Promise<unknown>) {
  try {
    res.json(await run());
  } catch (error: any) {
    if (error instanceof BillingError) return res.status(error.status).json({ message: error.message });
    if (error?.type && String(error.type).startsWith("Stripe")) {
      console.error("Stripe error:", error?.message);
      return res.status(502).json({ message: error?.message || fallback });
    }
    console.error(fallback, error);
    res.status(500).json({ message: fallback });
  }
}

/** 2keevo's admin view (ADMIN_EMAILS only). */
export default class AdminController {
  /** Subscribers, trials, failed payments, revenue by plan, discount requests. */
  static overview = async (_req: any, res: Response) => {
    await respond(res, "Could not load the overview", () => AdminService.overview());
  };

  static approveDiscount = async (req: any, res: Response) => {
    await respond(res, "Could not approve the request", () => DiscountService.decide(Number(req.params.id), true));
  };

  static declineDiscount = async (req: any, res: Response) => {
    await respond(res, "Could not decline the request", () => DiscountService.decide(Number(req.params.id), false));
  };

  /** The company no longer qualifies: full price from the next invoice. */
  static removeDiscount = async (req: any, res: Response) => {
    await respond(res, "Could not remove the discount", () => DiscountService.remove(Number(req.params.id)));
  };
}
