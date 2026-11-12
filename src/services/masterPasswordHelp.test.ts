import { afterEach, describe, expect, it, vi } from "vitest";
import EmailService from "@src/services/EmailService";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendMasterPasswordHelp", () => {
  it("doesn't promise an admin reset (companies can no longer reset master passwords)", async () => {
    const deliver = vi.spyOn(EmailService as any, "deliver").mockResolvedValue(true);
    await EmailService.sendMasterPasswordHelp({ to: "sam@example.com" });
    const [, , text, html] = deliver.mock.calls[0] as string[];
    for (const body of [text, html]) {
      expect(body).not.toMatch(/admin/i);
      expect(body).toMatch(/your company can't reset it/i);
    }
  });
});
