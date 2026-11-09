/** Work item ownership: one company owns an item, and it only sits in that company's collections. Pure, no DB. */

type CollectionRef = { id: number; companyId: number | null };

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

/** The company that owns an item from its collections, or null for a personal item. */
export function owningCompany(collections: CollectionRef[]): number | null {
  const companies = new Set<number>();
  let personal = false;
  for (const c of collections) {
    if (c.companyId === null || c.companyId === undefined) personal = true;
    else companies.add(c.companyId);
  }
  if (companies.size > 1) fail(400, "An item can belong to only one company.");
  if (companies.size === 1 && personal) {
    fail(400, "A company item can only be in that company's collections.");
  }
  return companies.size === 1 ? [...companies][0] : null;
}

/**
 * Validates a collection change; a company item may not leave its company, only be copied out.
 * `legacyWork`: an item already in company collections without a companyId (left by the backfill):
 * it is a work item too, so it may not leave either, and gets the one company it ends up in.
 */
export function checkCollectionChange(
  currentCompanyId: number | null,
  next: CollectionRef[],
  legacyWork = false
): { companyId: number | null; movesToCompany: boolean } {
  const nextCompanyId = owningCompany(next);
  if (currentCompanyId === null && legacyWork) {
    if (nextCompanyId === null) fail(409, "A company item stays in the company. Copy it to your personal vault instead.");
    return { companyId: nextCompanyId, movesToCompany: false };
  }
  // Check the other-company case first so naming a new company is a 400, not a "stays" 409.
  if (currentCompanyId !== null && nextCompanyId !== null && nextCompanyId !== currentCompanyId) {
    fail(400, "An item can belong to only one company.");
  }
  if (currentCompanyId !== null && nextCompanyId === null) {
    fail(409, "A company item stays in the company. Copy it to your personal vault instead.");
  }
  return {
    companyId: nextCompanyId,
    movesToCompany: currentCompanyId === null && nextCompanyId !== null,
  };
}

/**
 * A company's item (work item): it belongs to the company, so whoever made it
 * gets no more than their company access gives. Items still in company
 * collections without a companyId (left by the backfill) count too.
 */
export function isWorkItem(
  note: { companyId?: number | null },
  collections?: { companyId?: number | null }[]
): boolean {
  return note.companyId != null || !!collections?.some((collection) => collection.companyId);
}
