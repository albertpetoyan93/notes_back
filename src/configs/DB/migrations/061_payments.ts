import sequelize from "../sequelize";

/**
 * payments: one row per Stripe invoice that charged money (or tried to), copied from the
 * webhooks (invoice.paid, invoice.payment_failed, charge.refunded) and a backfill script.
 * Users see their own; admins see totals and every row. Rows outlive a deleted account
 * (owner set to NULL): payment records are kept for accounting.
 */
export const useTransaction = false;

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "payments" (
    id SERIAL PRIMARY KEY,
    "stripeInvoiceId" VARCHAR(255) NOT NULL UNIQUE,
    "stripePaymentIntentId" VARCHAR(255),
    "userId" INTEGER REFERENCES "users"(id) ON DELETE SET NULL,
    "companyId" INTEGER REFERENCES "companies"(id) ON DELETE SET NULL,
    "plan" VARCHAR(20),
    "interval" VARCHAR(10),
    "status" VARCHAR(20) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL DEFAULT 0,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "refundedCents" INTEGER NOT NULL DEFAULT 0,
    "promoCode" VARCHAR(255),
    "invoiceNumber" VARCHAR(255),
    "invoicePdf" TEXT,
    "hostedInvoiceUrl" TEXT,
    "periodStart" TIMESTAMPTZ,
    "periodEnd" TIMESTAMPTZ,
    "paidAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS "payments_paid_at" ON "payments" ("paidAt")`,
  `CREATE INDEX IF NOT EXISTS "payments_user" ON "payments" ("userId")`,
  `CREATE INDEX IF NOT EXISTS "payments_company" ON "payments" ("companyId")`,
  `CREATE INDEX IF NOT EXISTS "payments_payment_intent" ON "payments" ("stripePaymentIntentId")`,
];

export async function up() {
  try {
    for (const statement of STATEMENTS) {
      await sequelize.query(statement);
    }
  } catch (error: any) {
    if (error?.parent?.code === "42501" || error?.original?.code === "42501") {
      throw new Error(`Database user cannot alter these tables. As the table owner, run: ${STATEMENTS.join("; ")};`);
    }
    throw error;
  }
}
