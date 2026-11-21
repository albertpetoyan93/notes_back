import { describe, expect, it } from "vitest";
import User from "@src/models/User";
import E2EAccountService from "@src/services/E2EAccountService";
import { table } from "@src/services/recoveryTestDb";
import AuthService from "@src/services/AuthService";
import { userByEmail } from "@src/util/userByEmail";

describe("prelogin", () => {
  it("SEC06: the letter case of the address doesn't reveal whether the account exists", async () => {
    table(User, [{ id: 1, email: "bob@example.com", e2eEnabled: true, kdfSalt: "real-salt", kdfParams: { memory: 65536 } }]);
    const exact = await E2EAccountService.prelogin("bob@example.com");
    const shouted = await E2EAccountService.prelogin("BOB@Example.com");
    expect(shouted).toEqual(exact);
  });
});

describe("sign-in finds the same account as prelogin", () => {
  const authKey = "a".repeat(43);

  it("a capitalised address with a space at the end still signs in (phone keyboards and autofill)", async () => {
    table(User, [
      { id: 1, email: "bob@example.com", e2eEnabled: true, kdfSalt: "s", kdfParams: {}, comparePassword: async () => true },
    ]);
    const user = await AuthService.login({ email: " Bob@Example.com ", password: "", authKey } as never);
    expect(user.id).toBe(1);
  });

  it("an address that isn't there is still refused", async () => {
    table(User, [{ id: 1, email: "bob@example.com", e2eEnabled: true, comparePassword: async () => true }]);
    await expect(AuthService.login({ email: "eve@example.com", password: "", authKey } as never)).rejects.toThrow(
      "Invalid credentials"
    );
  });

  it("a % or _ in the typed address matches only itself", async () => {
    table(User, [{ id: 1, email: "bob@example.com" }]);
    expect(await userByEmail("%@example.com")).toBeNull();
    expect(await userByEmail("b_b@example.com")).toBeNull();
  });
});
