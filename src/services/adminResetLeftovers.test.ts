import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import User from "@src/models/User";
import AdminResetLeftovers from "@src/services/AdminResetLeftovers";
import EmailService from "@src/services/EmailService";
import NotificationService from "@src/services/NotificationService";
import { table } from "@src/services/recoveryTestDb";

beforeEach(() => {
  vi.spyOn(NotificationService, "create").mockResolvedValue(undefined as never);
  vi.spyOn(EmailService, "sendSecurityNotice").mockResolvedValue(true as never);
  table(User, [
    { id: 1, email: "kept-temp@acme.com", e2eEnabled: true, mustChangeMasterPassword: true },
    { id: 2, email: "fine@acme.com", e2eEnabled: true, mustChangeMasterPassword: false },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AdminResetLeftovers (old admin-set master passwords)", () => {
  it("lists only accounts still on a master password an admin set", async () => {
    expect(await AdminResetLeftovers.list()).toEqual([{ id: 1, email: "kept-temp@acme.com" }]);
  });

  it("tells nobody unless asked (dry run by default)", async () => {
    const result = await AdminResetLeftovers.run({ notify: false });
    expect(result).toEqual({ found: 1, notified: 0 });
    expect(NotificationService.create).not.toHaveBeenCalled();
  });

  it("with notify, tells each of them in the app and by email", async () => {
    const result = await AdminResetLeftovers.run({ notify: true });
    expect(result).toEqual({ found: 1, notified: 1 });
    expect(NotificationService.create).toHaveBeenCalledWith(1, expect.stringMatching(/set by a company admin/));
    expect(EmailService.sendSecurityNotice).toHaveBeenCalledWith(expect.objectContaining({ to: "kept-temp@acme.com" }));
  });
});
