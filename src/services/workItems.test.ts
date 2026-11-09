import { describe, expect, it } from "vitest";
import { checkCollectionChange, owningCompany } from "./workItems";

function thrown(fn: () => unknown): { status?: number; message: string } {
  try {
    fn();
  } catch (err) {
    return err as { status?: number; message: string };
  }
  throw new Error("expected a throw");
}

describe("owningCompany", () => {
  it("is null with no collections or only personal ones", () => {
    expect(owningCompany([])).toBeNull();
    expect(owningCompany([{ id: 1, companyId: null }])).toBeNull();
  });

  it("returns the company when all collections belong to it", () => {
    expect(
      owningCompany([
        { id: 2, companyId: 7 },
        { id: 3, companyId: 7 },
      ])
    ).toBe(7);
  });

  it("refuses a mix of company and personal collections", () => {
    const err = thrown(() =>
      owningCompany([
        { id: 2, companyId: 7 },
        { id: 1, companyId: null },
      ])
    );
    expect(err.status).toBe(400);
    expect(err.message).toBe("A company item can only be in that company's collections.");
  });

  it("refuses two companies", () => {
    const err = thrown(() =>
      owningCompany([
        { id: 2, companyId: 7 },
        { id: 4, companyId: 9 },
      ])
    );
    expect(err.status).toBe(400);
    expect(err.message).toBe("An item can belong to only one company.");
  });
});

describe("checkCollectionChange", () => {
  it("refuses removing the last company collection with 409", () => {
    const err = thrown(() => checkCollectionChange(7, []));
    expect(err.status).toBe(409);
    expect(err.message).toBe(
      "A company item stays in the company. Copy it to your personal vault instead."
    );
  });

  it("reports a personal item moving into a company", () => {
    expect(checkCollectionChange(null, [{ id: 2, companyId: 7 }])).toEqual({
      companyId: 7,
      movesToCompany: true,
    });
  });

  it("keeps a company item in its company", () => {
    expect(checkCollectionChange(7, [{ id: 2, companyId: 7 }])).toEqual({
      companyId: 7,
      movesToCompany: false,
    });
  });

  it("refuses a change that names another company", () => {
    const err = thrown(() => checkCollectionChange(7, [{ id: 4, companyId: 9 }]));
    expect(err.status).toBe(400);
    expect(err.message).toBe("An item can belong to only one company.");
  });
});
