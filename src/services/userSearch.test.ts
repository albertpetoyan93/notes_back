import { beforeEach, describe, expect, it } from "vitest";
import User from "@src/models/User";
import UserService from "@src/services/UserService";
import { table } from "@src/services/recoveryTestDb";

const confirmed = new Date("2026-01-01");

beforeEach(() => {
  table(User, [
    { id: 1, email: "me@example.com", username: "me", fullName: "Me", emailVerifiedAt: confirmed },
    { id: 2, email: "bob.smith@gmail.com", username: "bobby", fullName: "Bob Smith", emailVerifiedAt: confirmed },
    { id: 3, email: "ann@gmail.com", username: "ann", fullName: "Ann Lee", emailVerifiedAt: confirmed },
  ]);
});

const ids = (rows: unknown[]) => (rows as { id: number }[]).map((row) => row.id).sort();

describe("finding someone to share with (outside a company)", () => {
  it("SEC06: a part of an address or name finds nobody: the user list can't be harvested", async () => {
    expect(ids(await UserService.searchUsers("gmail", 1))).toEqual([]);
    expect(ids(await UserService.searchUsers("%%", 1))).toEqual([]);
    expect(ids(await UserService.searchUsers("Smith", 1))).toEqual([]);
  });

  it("the full email (any letter case) or exact username finds that one person", async () => {
    expect(ids(await UserService.searchUsers("Bob.Smith@Gmail.com", 1))).toEqual([2]);
    expect(ids(await UserService.searchUsers("ann", 1))).toEqual([3]);
  });

  it("wildcards in the typed text are taken literally", async () => {
    expect(ids(await UserService.searchUsers("bob_smith@gmail.com", 1))).toEqual([]);
    expect(ids(await UserService.searchUsers("%@gmail.com", 1))).toEqual([]);
  });
});
