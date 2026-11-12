import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EnvVars from "@src/common/EnvVars";
import EmailService from "@src/services/EmailService";

const mail = EnvVars.Mail as { From: string; SecurityFrom?: string };
let sendMail: ReturnType<typeof vi.fn>;
const sentFrom = () => (sendMail.mock.calls.at(-1)![0] as { from: string }).from;

beforeEach(() => {
  sendMail = vi.fn().mockResolvedValue({});
  vi.spyOn(EmailService, "isConfigured").mockReturnValue(true);
  vi.spyOn(EmailService as any, "transport").mockReturnValue({ sendMail });
  mail.From = "2keevo <support@2keevo.com>";
  mail.SecurityFrom = "2keevo Security <security@2keevo.com>";
});

afterEach(() => vi.restoreAllMocks());

describe("which address an email comes from", () => {
  const to = "sam@acme.com";

  it("account-safety emails come from the security address", async () => {
    const security: (() => Promise<unknown>)[] = [
      () => EmailService.sendNewSignIn({ to, device: "Chrome", how: "password", ip: null, time: new Date() }),
      () => EmailService.sendPasswordReset({ to, token: "t" }),
      () => EmailService.sendAccountResetLink({ to, token: "t" }),
      () => EmailService.sendMasterPasswordHelp({ to }),
      () => EmailService.sendTwoFactorChanged({ to, enabled: true }),
      () => EmailService.sendRemoveTwoFactorConfirm({ to, link: "https://x", expiresAt: new Date() }),
      () => EmailService.sendSecurityNotice({ to, what: "x" }),
      () => EmailService.sendE2EReminder({ to, deadline: null }),
    ];
    for (const send of security) {
      await send();
      expect(sentFrom()).toBe("2keevo Security <security@2keevo.com>");
    }
  });

  it("everything else comes from the main address", async () => {
    await EmailService.sendEmailConfirmation({ to, token: "t" });
    expect(sentFrom()).toBe("2keevo <support@2keevo.com>");
    await EmailService.sendCompanyInvite({ to, companyId: 1, companyName: "Acme", token: "t" });
    expect(sentFrom()).toBe("2keevo <support@2keevo.com>");
    await EmailService.sendFamilyInvite({ to, organizer: "Olga" });
    expect(sentFrom()).toBe("2keevo <support@2keevo.com>");
  });

  it("without a security address set, security emails use the main one", async () => {
    mail.SecurityFrom = "";
    await EmailService.sendNewSignIn({ to, device: "Chrome", how: "password", ip: null, time: new Date() });
    expect(sentFrom()).toBe("2keevo <support@2keevo.com>");
  });
});
