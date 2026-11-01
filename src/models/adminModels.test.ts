import { describe, expect, it } from "vitest";
import AdminStaff from "@src/models/AdminStaff";
import AdminAction from "@src/models/AdminAction";
import UserActivityDay from "@src/models/UserActivityDay";
import SupportRequest from "@src/models/SupportRequest";

describe("admin models", () => {
  it("declares the admin tables", () => {
    expect(AdminStaff.getTableName()).toBe("admin_staff");
    expect(AdminAction.getTableName()).toBe("admin_actions");
    expect(UserActivityDay.getTableName()).toBe("user_activity_days");
    expect(SupportRequest.getTableName()).toBe("support_requests");
    expect(Object.keys(UserActivityDay.getAttributes())).toEqual(
      expect.arrayContaining(["userId", "date", "web", "extension"])
    );
  });
});
