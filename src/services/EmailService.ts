import logger from "jet-logger";
import nodemailer from "nodemailer";
import EnvVars from "../common/EnvVars";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

class EmailService {
  isConfigured() {
    return Boolean(EnvVars.Mail.Host && EnvVars.Mail.From);
  }

  private transport() {
    return nodemailer.createTransport({
      host: EnvVars.Mail.Host,
      port: EnvVars.Mail.Port,
      secure: EnvVars.Mail.Secure,
      auth: EnvVars.Mail.User
        ? { user: EnvVars.Mail.User, pass: EnvVars.Mail.Password }
        : undefined,
    });
  }

  private async deliver(
    to: string,
    subject: string,
    text: string,
    html: string,
  ) {
    if (!this.isConfigured()) {
      logger.info(
        `Email skipped (SMTP is not configured). To: ${to}. ${subject}`,
      );
      return false;
    }
    try {
      await this.transport().sendMail({
        from: EnvVars.Mail.From,
        to,
        subject,
        text,
        html,
      });
      return true;
    } catch (error) {
      logger.err(`Failed to send email to ${to}: ${error}`);
      throw Object.assign(new Error("Could not send the email"), {
        status: 502,
      });
    }
  }

  async sendCompanyInvite(input: {
    to: string;
    companyId: number;
    companyName: string;
  }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/company/${input.companyId}`;
    const companyName = input.companyName || "A Company";
    const subject = `Invitation to join ${companyName} on 2keevo`;
    const text = [
      `You have been invited to join ${companyName} on 2keevo.`,
      "",
      "Click below to accept the invitation and access your workspace.",
      "",
      link,
      "",
      "Note: This invitation will expire in 14 days. If you don't have a 2keevo account yet, please sign up using this email address first.",
    ].join("\n");
    const safeName = escapeHtml(companyName);
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">You have been invited to join <strong>${safeName}</strong> on 2keevo.</p>
<p style="margin:0 0 16px;">Click below to accept the invitation and access your workspace.</p>
<p style="margin:0 0 20px;"><a href="${safeLink}" style="display:inline-block;background:#1677ff;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Open Invite</a></p>
<p style="margin:0;color:#6b7280;font-size:13px;">Note: This invitation will expire in 14 days. If you don't have a 2keevo account yet, please sign up using this email address first.</p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  async sendNoteShare(input: { to: string; noteTitle: string; companyId?: number | null }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = input.companyId
      ? `${origin}/company/${input.companyId}`
      : `${origin}/notes`;
    // End-to-end items have no title on the server: the email doesn't name them.
    const named = input.noteTitle ? `"${input.noteTitle}"` : "An item";
    const subject = "A note was shared with you on 2keevo";
    const text = [
      `${named} has been shared with you on 2keevo.`,
      "",
      "Click below to open it.",
      "",
      link,
    ].join("\n");
    const safeTitle = input.noteTitle ? escapeHtml(input.noteTitle) : "An item";
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;"><strong>${safeTitle}</strong> has been shared with you on 2keevo.</p>
<p style="margin:0 0 16px;">Click below to open it.</p>
<p style="margin:0;"><a href="${safeLink}" style="display:inline-block;background:#1677ff;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Open Note</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  async sendPasswordReset(input: { to: string; token: string }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/auth/reset?token=${encodeURIComponent(input.token)}`;
    const subject = "Reset your 2keevo password";
    const text = [
      "We received a request to reset your 2keevo password.",
      "",
      "Click below to choose a new password. This link expires in 1 hour.",
      "",
      link,
      "",
      "If you did not ask for this, you can ignore this email.",
    ].join("\n");
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">We received a request to reset your 2keevo password.</p>
<p style="margin:0 0 16px;">Click below to choose a new password. This link expires in 1 hour.</p>
<p style="margin:0 0 20px;"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Reset password</a></p>
<p style="margin:0;color:#6b7280;font-size:13px;">If you did not ask for this, you can ignore this email.</p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** Asked for a password reset on an end-to-end account: what works instead. */
  async sendMasterPasswordHelp(input: { to: string }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/auth/recover`;
    const subject = "About resetting your 2keevo master password";
    const text = [
      "We received a request to reset your 2keevo password.",
      "",
      "Your account uses a master password (end-to-end encryption). 2keevo can't read your vault, so it can't be reset by email.",
      "",
      "- Use your recovery key: " + link,
      "- Or, in a company with admin recovery turned on, ask an owner or admin to reset it.",
      "",
      "If you did not ask for this, you can ignore this email. Nothing has changed.",
    ].join("\n");
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">We received a request to reset your 2keevo password.</p>
<p style="margin:0 0 16px;">Your account uses a master password (end-to-end encryption). 2keevo can't read your vault, so it can't be reset by email.</p>
<p style="margin:0 0 16px;"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Use your recovery key</a></p>
<p style="margin:0 0 16px;">Or, in a company with admin recovery turned on, ask an owner or admin to reset it.</p>
<p style="margin:0;color:#6b7280;font-size:13px;">If you did not ask for this, you can ignore this email. Nothing has changed.</p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  async sendNewSignIn(input: {
    to: string;
    device: string;
    how: string;
    ip: string | null;
    time: Date;
  }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/security`;
    const when = `${input.time.toLocaleString("en-GB", {
      timeZone: "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    })} UTC`;
    const subject = `New sign-in to 2keevo from ${input.device}`;
    const facts = [
      `Device: ${input.device}`,
      `How: ${input.how}`,
      `When: ${when}`,
      ...(input.ip ? [`IP address: ${input.ip}`] : []),
    ];
    const text = [
      "Your 2keevo account was just signed in from a device it hasn't seen before.",
      "",
      ...facts,
      "",
      "If this was you, there is nothing to do.",
      "If it wasn't, change your password and sign out the other devices:",
      "",
      link,
    ].join("\n");
    const safeLink = escapeHtml(link);
    const rows = facts
      .map((fact) => {
        const [label, ...rest] = fact.split(": ");
        return `<tr><td style="padding:2px 16px 2px 0;color:#6b7280;">${escapeHtml(label)}</td><td style="padding:2px 0;">${escapeHtml(rest.join(": "))}</td></tr>`;
      })
      .join("");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">Your 2keevo account was just signed in from a device it hasn't seen before.</p>
<table style="margin:0 0 16px;border-collapse:collapse;font-size:14px;">${rows}</table>
<p style="margin:0 0 16px;">If this was you, there is nothing to do. If it wasn't, change your password and sign out the other devices.</p>
<p style="margin:0;"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Security settings</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** A short "this changed on your account" email with a link to Security settings. */
  async sendSecurityNotice(input: { to: string; what: string }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/security`;
    const subject = "A security change on your 2keevo account";
    const text = [
      input.what,
      "",
      "If this wasn't you, contact us and review your security settings:",
      "",
      link,
    ].join("\n");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">${escapeHtml(input.what)}</p>
<p style="margin:0 0 16px;">If this wasn't you, review your security settings right away.</p>
<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Security settings</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** Accounts that haven't turned on end-to-end encryption yet (npm run e2e:remind). */
  async sendE2EReminder(input: { to: string; deadline: string | null }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/security`;
    const by = input.deadline
      ? ` by ${new Date(input.deadline).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
      : "";
    const subject = "Turn on end-to-end encryption for your 2keevo vault";
    const what = `2keevo now encrypts your vault in your browser, so nobody else (not even 2keevo) can read it. Please turn it on${by}: your password becomes your master password, and you get a recovery key. It takes a minute.`;
    const text = [what, "", link].join("\n");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">${escapeHtml(what)}</p>
<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Turn it on</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  async sendTwoFactorChanged(input: { to: string; enabled: boolean }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/security`;
    const state = input.enabled ? "turned on" : "turned off";
    const subject = `Two-factor authentication was ${state} on 2keevo`;
    const text = [
      `Two-factor authentication was ${state} for your 2keevo account.`,
      "",
      "If this was not you, reset your password right away and review your security settings:",
      "",
      link,
    ].join("\n");
    const safeLink = escapeHtml(link);
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">Two-factor authentication was <strong>${state}</strong> for your 2keevo account.</p>
<p style="margin:0 0 16px;">If this was not you, reset your password right away and review your security settings.</p>
<p style="margin:0;"><a href="${safeLink}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Security settings</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** A trial ends in a few days; nothing is charged either way. */
  async sendTrialEnding(input: { to: string; planName: string; endsAt: Date; companyName?: string | null }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/billing`;
    const day = input.endsAt.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const what = input.companyName ? `${input.companyName}'s ${input.planName} trial` : `Your ${input.planName} trial`;
    const subject = `${what} ends on ${day}`;
    const text = [
      `${what} on 2keevo ends on ${day}.`,
      "",
      "Nothing will be charged. If you don't subscribe, the account moves to the Free plan and every item stays where it is.",
      "",
      `Keep ${input.planName}: ${link}`,
    ].join("\n");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">${escapeHtml(what)} on 2keevo ends on <strong>${escapeHtml(day)}</strong>.</p>
<p style="margin:0 0 16px;">Nothing will be charged. If you don't subscribe, the account moves to the Free plan and every item stays where it is.</p>
<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">Keep ${escapeHtml(input.planName)}</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** A trial ended without a subscription: back on Free, nothing deleted. */
  async sendTrialEnded(input: { to: string; planName: string; companyName?: string | null }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}/settings/billing`;
    const what = input.companyName ? `${input.companyName}'s ${input.planName} trial` : `Your ${input.planName} trial`;
    const subject = `${what} has ended`;
    const text = [
      `${what} on 2keevo has ended, and the account is on the Free plan now.`,
      "",
      "Nothing was deleted. Collections and shares over the Free limits keep working; you just can't add new ones.",
      "",
      `Subscribe any time: ${link}`,
    ].join("\n");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
<p style="margin:0 0 16px;">${escapeHtml(what)} on 2keevo has ended, and the account is on the Free plan now.</p>
<p style="margin:0 0 16px;">Nothing was deleted. Collections and shares over the Free limits keep working; you just can't add new ones.</p>
<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">See plans</a></p>
</div>`;
    return this.deliver(input.to, subject, text, html);
  }

  /** A short billing notice: paragraphs and one button. */
  private notice(to: string, subject: string, paragraphs: string[], button: { label: string; path: string }) {
    const origin = EnvVars.FrontendOrigin || "http://localhost:5173";
    const link = `${origin}${button.path}`;
    const text = [...paragraphs.flatMap((paragraph) => [paragraph, ""]), `${button.label}: ${link}`].join("\n");
    const html = `<div style="font-family:Segoe UI,sans-serif;color:#1f2937;line-height:1.5;">
${paragraphs.map((paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph)}</p>`).join("\n")}
<p style="margin:0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#6d5efc;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;">${escapeHtml(button.label)}</a></p>
</div>`;
    return this.deliver(to, subject, text, html);
  }

  private day(date: Date) {
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  }

  async sendFamilyInvite(input: { to: string; organizer: string }) {
    return this.notice(
      input.to,
      `${input.organizer} invited you to their 2keevo Family`,
      [
        `${input.organizer} invited you to join their Family plan on 2keevo. You get Premium, your own private vault, and a collection shared with the family.`,
        "Your vault stays private: the organizer can't see your items, only what you put in the family collection.",
        "The invitation expires in 14 days. If you don't have a 2keevo account yet, sign up with this email address first.",
      ],
      { label: "Open the invitation", path: "/settings/billing" }
    );
  }

  /** Existing companies, when Team trials start for everyone. */
  async sendCompanyTrialStarted(input: { to: string; companyName: string; endsAt: Date }) {
    return this.notice(
      input.to,
      `${input.companyName} has a free Team trial until ${this.day(input.endsAt)}`,
      [
        `Companies on 2keevo are part of the Team plan now. ${input.companyName} gets a free 14-day Team trial: nothing is charged and nothing changes for your members.`,
        `To keep the company open after ${this.day(input.endsAt)}, subscribe to Team. Only members who accepted their invitation are billed, with a minimum of 2.`,
        "If the trial ends unpaid, the company is suspended: its items are hidden but kept, everyone's personal vaults are untouched, and you can still export the company's items.",
      ],
      { label: "Subscribe to Team", path: "/settings/billing" }
    );
  }

  async sendPaymentFailed(input: { to: string; planName: string; companyName?: string | null; graceEndsAt: Date }) {
    const what = input.companyName ? `${input.companyName}'s ${input.planName} plan` : `your ${input.planName} plan`;
    const after = input.companyName
      ? "the company is suspended (its items are hidden but kept)"
      : "the account moves to the Free plan (nothing is deleted)";
    return this.notice(
      input.to,
      `Payment failed for ${what}`,
      [
        `The latest payment for ${what} on 2keevo didn't go through. Stripe will try again over the next days.`,
        `Everything keeps working until ${this.day(input.graceEndsAt)}. If no payment goes through by then, ${after}.`,
        "Updating the card usually fixes it.",
      ],
      { label: "Update payment method", path: "/settings/billing" }
    );
  }

  async sendRenewalReminder(input: { to: string; planName: string; companyName?: string | null; renewsAt: Date }) {
    const what = input.companyName ? `${input.companyName}'s yearly ${input.planName} plan` : `Your yearly ${input.planName} plan`;
    return this.notice(
      input.to,
      `${what} renews on ${this.day(input.renewsAt)}`,
      [
        `${what} on 2keevo renews on ${this.day(input.renewsAt)}, and the card on file will be charged for another year.`,
        "Nothing to do if you'd like to keep it. To change or cancel it, open Billing before that date.",
      ],
      { label: "Manage billing", path: "/settings/billing" }
    );
  }

  async sendCompanySuspended(input: { to: string; companyName: string }) {
    return this.notice(
      input.to,
      `${input.companyName} is suspended on 2keevo`,
      [
        `${input.companyName} no longer has a Team plan, so the company is suspended. Its items are hidden from members but kept, and everyone's personal vaults are untouched.`,
        "As the owner you can still export the company's items. Subscribe to Team to reopen the company exactly as it was.",
      ],
      { label: "Reopen the company", path: "/settings/billing" }
    );
  }

  /** A suspended company nears 90 days unpaid. */
  async sendRemovalWarning(input: { to: string; companyName: string; removalOn: Date; final: boolean }) {
    return this.notice(
      input.to,
      `${input.final ? "Final warning: " : ""}${input.companyName}'s items may be removed on ${this.day(input.removalOn)}`,
      [
        `${input.companyName} has been suspended on 2keevo without a Team plan. After ${this.day(input.removalOn)}, the company and its items may be removed for good.`,
        "Members' personal vaults are never removed. To keep the company's items, subscribe to Team or export them before that date.",
      ],
      { label: "Keep the company", path: "/settings/billing" }
    );
  }

  /** To 2keevo's admins: a company asked for the nonprofit or school discount. */
  async sendDiscountRequested(input: { to: string; companyName: string; organization: string; kind: string }) {
    return this.notice(
      input.to,
      `Discount request: ${input.companyName}`,
      [`${input.companyName} asked for the ${input.kind} discount, as ${input.organization}.`],
      { label: "Review it", path: "/admin" }
    );
  }

  /** To the company owner: what 2keevo decided about their discount request. */
  async sendDiscountDecision(input: { to: string; companyName: string; approved: boolean; percent: number }) {
    return this.notice(
      input.to,
      input.approved
        ? `${input.companyName} now has ${input.percent}% off Team`
        : `About ${input.companyName}'s discount request`,
      input.approved
        ? [
            `Your request was approved: ${input.companyName} gets ${input.percent}% off Team for as long as it stays on Team.`,
            "If the company already pays, the discount applies from the next invoice. Otherwise it's taken off when you subscribe.",
          ]
        : [
            `We couldn't approve the nonprofit or school discount for ${input.companyName}.`,
            "If you think we got it wrong, send the request again from Billing, with a link that shows the organization's status.",
          ],
      { label: "Open Billing", path: "/settings/billing" }
    );
  }
}

export default new EmailService();
