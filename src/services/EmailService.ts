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
    const title = input.noteTitle || "A note";
    const subject = "A note was shared with you on 2keevo";
    const text = [
      `"${title}" has been shared with you on 2keevo.`,
      "",
      "Click below to open it.",
      "",
      link,
    ].join("\n");
    const safeTitle = escapeHtml(title);
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
}

export default new EmailService();
