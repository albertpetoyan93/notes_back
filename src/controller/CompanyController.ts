import { Response } from "express";
import CompanyService from "../services/CompanyService";
import AuditService from "../services/AuditService";
import CompanyMember from "../models/CompanyMember";
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
      const updated = await CompanyService.updateMemberRole(
        companyId,
        userId,
        memberId,
        req.body?.role || ""
      );
      const member = await CompanyMember.findByPk(memberId);
      await AuditService.record({
        actorId: userId,
        action: "member_role_changed",
        companyId,
        targetUserId: member?.userId ?? null,
        details: { email: member?.email, role: req.body?.role || "" },
        req,
      });
      res.json(updated);
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
      const member = await CompanyMember.findByPk(memberId);
      const result = await CompanyService.removeMember(companyId, userId, memberId);
      await AuditService.record({
        actorId: userId,
        action: "member_removed",
        companyId,
        targetUserId: member?.userId ?? null,
        details: { email: member?.email, role: member?.role },
        req,
      });
      res.json(result);
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
      const shared = await CollectionService.shareCompanyCollection(
        companyId,
        collectionId,
        userId,
        req.body?.audience || "",
        req.body?.permission || "view",
        emails
      );
      await AuditService.record({
        actorId: userId,
        action: "collection_shared",
        companyId,
        collectionId,
        details: {
          audience: req.body?.audience || "",
          permission: req.body?.permission || "view",
          people: emails.length || undefined,
        },
        req,
      });
      res.json(shared);
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
      const target = memberUserId && !isNaN(memberUserId) ? memberUserId : undefined;
      const unshared = await CollectionService.unshareCompanyCollection(
        companyId,
        collectionId,
        userId,
        { all: req.query.all === "1", memberUserId: target }
      );
      await AuditService.record({
        actorId: userId,
        action: "collection_share_revoked",
        companyId,
        collectionId,
        targetUserId: target ?? null,
        details: req.query.all === "1" ? { audience: "all" } : {},
        req,
      });
      res.json(unshared);
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
      await AuditService.record({
        actorId: userId,
        action: "member_invited",
        companyId,
        details: { email: req.body?.email || "", role: req.body?.role || "member" },
        req,
      });
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

  // Company log, for owners and admins
  static activity = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId)) return res.status(400).json({ message: "Invalid company" });
      const before = parseInt(String(req.query.before || ""));
      const actorId = parseInt(String(req.query.actorId || ""));
      const page = await AuditService.companyLog(companyId, userId, {
        before: isNaN(before) ? undefined : before,
        actorId: isNaN(actorId) ? undefined : actorId,
        action: req.query.action ? String(req.query.action) : undefined,
      });
      if (!page) {
        return res.status(403).json({ message: "Only owners and admins can see the log" });
      }
      res.json(page);
    } catch (error) {
      console.error("Error loading company log:", error);
      res.status(500).json({ message: "Error loading the log" });
    }
  };

  // What a member could open and which secrets they looked at (offboarding)
  static memberAccess = async (req: any, res: Response) => {
    try {
      const userId = req.user?.id;
      const companyId = parseInt(req.params.id);
      const memberId = parseInt(req.params.memberId);
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (isNaN(companyId) || isNaN(memberId)) {
        return res.status(400).json({ message: "Invalid company" });
      }
      const member = await CompanyMember.findOne({ where: { id: memberId, companyId } });
      if (!member?.userId) {
        return res.json({ collections: [], secretsAccessed: [] });
      }
      const access = await AuditService.memberAccess(companyId, userId, member.userId);
      if (!access) {
        return res.status(403).json({ message: "Only owners and admins can see this" });
      }
      res.json(access);
    } catch (error) {
      console.error("Error loading member access:", error);
      res.status(500).json({ message: "Error loading member access" });
    }
  };
}
