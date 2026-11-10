import { describe, expect, it } from "vitest";
import E2EAccountService from "@src/services/E2EAccountService";

// A signed-in account, as far as the check needs one.
const account = (extra: Record<string, unknown> = {}) =>
  ({
    e2eEnabled: false,
    comparePassword: async (value: string) => value === "right password",
    ...extra,
  }) as never;

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a failure");
}

describe("checkPasswordForEnable", () => {
  it("accepts the account's current password", async () => {
    await expect(E2EAccountService.checkPasswordForEnable(account(), "right password")).resolves.toBeUndefined();
  });

  it("refuses a wrong password before any keys are made (401)", async () => {
    const err = await failure(E2EAccountService.checkPasswordForEnable(account(), "old password"));
    expect(err.status).toBe(401);
    expect(err.message).toBe("Your current password isn't right.");
  });

  it("refuses an empty password", async () => {
    const err = await failure(E2EAccountService.checkPasswordForEnable(account(), ""));
    expect(err.status).toBe(401);
  });

  it("refuses when end-to-end encryption is already on", async () => {
    const err = await failure(E2EAccountService.checkPasswordForEnable(account({ e2eEnabled: true }), "right password"));
    expect(err.status).toBe(400);
  });
});
