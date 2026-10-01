import { Response } from "express";
import CompanyService from "../services/CompanyService";
import CollectionService from "../services/CollectionService";

export default class CompanyController {
  static list = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      res.json(await CompanyService.list(userId));
    } catch (error) {
      console.error("Error listing companies:", error);
      res.status(500).json({ message: "Error listing companies" });
    }
  };

  static create = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const company = await CompanyService.create(userId, req.body?.name || "");
      res.status(201).json(company);
    } catch (error: any) {
      console.error("Error creating company:", error);
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error creating company",
      });
    }
  };

  static rename = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      res.json(await CompanyService.rename(companyId, userId, req.body?.name || ""));
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error renaming company",
      });
    }
  };

  static updateMember = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      const memberId = parseInt(req.params.memberId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId) || isNaN(memberId)) {
        return res.status(400).json({ message: "Invalid company" });
      }
      res.json(
        await CompanyService.updateMemberRole(companyId, userId, memberId, req.body?.role || "")
      );
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error updating member",
      });
    }
  };

  static removeMember = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      const memberId = parseInt(req.params.memberId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId) || isNaN(memberId)) {
        return res.status(400).json({ message: "Invalid company" });
      }
      res.json(await CompanyService.removeMember(companyId, userId, memberId));
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error removing member",
      });
    }
  };

  static collections = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      res.json(await CollectionService.listForCompany(companyId, userId));
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error loading collections",
      });
    }
  };

  static shareCollection = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      const collectionId = parseInt(req.params.collectionId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId) || isNaN(collectionId)) {
        return res.status(400).json({ message: "Invalid company" });
      }
      const emails = Array.isArray(req.body?.emails)
        ? req.body.emails
        : req.body?.email
          ? [req.body.email]
          : [];
      res.json(
        await CollectionService.shareCompanyCollection(
          companyId,
          collectionId,
          userId,
          req.body?.audience || "",
          req.body?.permission || "view",
          emails
        )
      );
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error sharing collection",
      });
    }
  };

  static unshareCollection = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      const collectionId = parseInt(req.params.collectionId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId) || isNaN(collectionId)) {
        return res.status(400).json({ message: "Invalid company" });
      }
      const memberUserId = req.query.userId ? parseInt(String(req.query.userId), 10) : undefined;
      res.json(
        await CollectionService.unshareCompanyCollection(companyId, collectionId, userId, {
          all: req.query.all === "1",
          memberUserId: memberUserId && !isNaN(memberUserId) ? memberUserId : undefined,
        })
      );
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error updating the share",
      });
    }
  };

  static createCollection = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      const collection = await CollectionService.createForCompany(
        companyId,
        userId,
        req.body?.name || ""
      );
      res.status(201).json(collection);
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error creating collection",
      });
    }
  };

  static members = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      res.json(await CompanyService.members(companyId, userId));
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error loading members",
      });
    }
  };

  static invite = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      const member = await CompanyService.invite(
        companyId,
        userId,
        req.body?.email || "",
        req.body?.role || "member"
      );
      res.status(201).json(member);
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error sending invite",
      });
    }
  };

  static accept = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      res.json(await CompanyService.accept(companyId, userId));
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error accepting invite",
      });
    }
  };

  static decline = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      await CompanyService.decline(companyId, userId);
      res.json({ ok: true });
    } catch (error: any) {
      res.status(error.status || 500).json({
        message: error.status ? error.message : "Error declining invite",
      });
    }
  };
}
