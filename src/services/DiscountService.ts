import { UniqueConstraintError } from "sequelize";
import { DISCOUNT_PERCENT } from "../common/plans";
import Company from "../models/Company";
import CompanyMember from "../models/CompanyMember";
import DiscountRequest, { DiscountKind } from "../models/DiscountRequest";
import { BillingError } from "./BillingService";
import { recipient } from "./CompanyBilling";
import EmailService from "./EmailService";
import StripeService from "./StripeService";

/**
 * 50% off Team for nonprofits and schools. The owner asks from Billing; a 2keevo admin
 * approves or declines from the admin view. One discount at a time: the coupon replaces
 * any promotion code.
 */

const KINDS: DiscountKind[] = ["nonprofit", "school"];

/** 2keevo's admins, by email (ADMIN_EMAILS, comma-separated). */
export function adminEmails() {
  return String(process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminEmail(email: string | null | undefined) {
  return !!email && adminEmails().includes(email.trim().toLowerCase());
}

const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);

class DiscountService {
  /** The owner asks for the discount. Body: { kind, organization, website?, note? }. */
  async request(userId: number, companyId: number, input: Record<string, unknown>) {
    const owner = await CompanyMember.findOne({ where: { companyId, userId, status: "active", role: "owner" } });
    if (!owner) throw new BillingError("Only the company's owner can ask for a discount.", 403);
    const company = await Company.findByPk(companyId, { attributes: ["id", "name", "discount"] });
    if (!company) throw new BillingError("Company not found.", 404);
    if (company.discount) throw new BillingError("This company already has the discount.", 409);

    const kind = input.kind as DiscountKind;
    if (!KINDS.includes(kind)) throw new BillingError("Choose nonprofit or school.");
    const organization = text(input.organization, 200);
    if (!organization) throw new BillingError("Enter the organization's name.");
    const website = text(input.website, 255) || null;
    if (website && !/^https?:\/\/\S+\.\S+/i.test(website)) {
      throw new BillingError("Enter the website as a full address, like https://example.org.");
    }

    let created: DiscountRequest;
    try {
      created = await DiscountRequest.create({
        companyId,
        userId,
        kind,
        organization,
        website,
        note: text(input.note, 2000) || null,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        throw new BillingError("A request for this company is already being reviewed.", 409);
      }
      throw error;
    }

    for (const to of adminEmails()) {
      await EmailService.sendDiscountRequested({ to, companyName: company.name, organization, kind }).catch((error) =>
        console.error("Could not email the discount request:", error?.message || error)
      );
    }
    return { id: created.id, status: created.status };
  }

  /** An admin approves or declines a pending request. */
  async decide(requestId: number, approved: boolean) {
    const request = await DiscountRequest.findByPk(requestId);
    if (!request || request.status !== "pending") throw new BillingError("That request isn't waiting for a decision.", 404);
    await request.update({ status: approved ? "approved" : "declined", decidedAt: new Date() });

    const company = await Company.findByPk(request.companyId, { attributes: ["id", "name", "discount"] });
    if (!company) return { ok: true };
    if (approved) {
      await company.update({ discount: request.kind });
      await StripeService.applyDiscount(company.id);
    }
    const to = await recipient({ companyId: company.id });
    if (to) {
      await EmailService.sendDiscountDecision({
        to: to.email,
        companyName: company.name,
        approved,
        percent: DISCOUNT_PERCENT,
      }).catch((error) => console.error("Could not email the discount decision:", error?.message || error));
    }
    return { ok: true };
  }

  /** An admin takes a company's discount away (it no longer qualifies). From the next invoice. */
  async remove(companyId: number) {
    const company = await Company.findByPk(companyId, { attributes: ["id", "discount"] });
    if (!company) throw new BillingError("Company not found.", 404);
    if (!company.discount) return { ok: true };
    await company.update({ discount: null });
    await StripeService.applyDiscount(company.id);
    return { ok: true };
  }
}

export default new DiscountService();
