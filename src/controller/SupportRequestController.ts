import { NextFunction, Request, Response } from "express";
import HttpStatusCodes from "../common/HttpStatusCodes";
import SupportRequestService from "../services/admin/SupportRequestService";

// The public side of a support request: the user confirming from the emailed link.
class SupportRequestController {
  static confirm = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = typeof req.body?.token === "string" ? req.body.token : "";
      res.status(HttpStatusCodes.OK).send(await SupportRequestService.confirm(token));
    } catch (e: any) {
      if (e?.status === HttpStatusCodes.GONE) {
        res.status(e.status).send({ message: e.message });
        return;
      }
      next(e);
    }
  };
}

export default SupportRequestController;
