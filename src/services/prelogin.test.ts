import { describe, expect, it } from "vitest";
import User from "@src/models/User";
import E2EAccountService from "@src/services/E2EAccountService";
import { table } from "@src/services/recoveryTestDb";

describe("prelogin", () => {
  it("SEC06: the letter case of the address doesn't reveal whether the account exists", async () => {
    table(User, [{ id: 1, email: "bob@example.com", e2eEnabled: true, kdfSalt: "real-salt", kdfParams: { memory: 65536 } }]);
    const exact = await E2EAccountService.prelogin("bob@example.com");
    const shouted = await E2EAccountService.prelogin("BOB@Example.com");
    expect(shouted).toEqual(exact);
  });
});
