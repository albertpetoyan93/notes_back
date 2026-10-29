import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";
import type { PlanId } from "../common/plans";

export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";

interface SubscriptionAttributes {
  id: number;
  /** Set for Premium and Family; the person who pays. */
  userId?: number | null;
  /** Set for Team; the company that pays. */
  companyId?: number | null;
  plan: PlanId;
  interval?: "month" | "year" | null;
  status: SubscriptionStatus;
  seats?: number | null;
  trialEndsAt?: Date | null;
  trialReminderSentAt?: Date | null;
  currentPeriodEnd?: Date | null;
  cancelAtPeriodEnd: boolean;
  graceEndsAt?: Date | null;
  /** Yearly renewal reminder sent for the period ending at currentPeriodEnd. */
  renewalReminderSentAt?: Date | null;
  /** The payment-failed email for the current grace period. */
  paymentFailedEmailedAt?: Date | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type SubscriptionCreation = Optional<
  SubscriptionAttributes,
  | "id"
  | "userId"
  | "companyId"
  | "interval"
  | "seats"
  | "trialEndsAt"
  | "trialReminderSentAt"
  | "currentPeriodEnd"
  | "cancelAtPeriodEnd"
  | "graceEndsAt"
  | "renewalReminderSentAt"
  | "paymentFailedEmailedAt"
  | "stripeCustomerId"
  | "stripeSubscriptionId"
  | "createdAt"
  | "updatedAt"
>;

class Subscription
  extends Model<SubscriptionAttributes, SubscriptionCreation>
  implements SubscriptionAttributes
{
  public id!: number;
  public userId?: number | null;
  public companyId?: number | null;
  public plan!: PlanId;
  public interval?: "month" | "year" | null;
  public status!: SubscriptionStatus;
  public seats?: number | null;
  public trialEndsAt?: Date | null;
  public trialReminderSentAt?: Date | null;
  public currentPeriodEnd?: Date | null;
  public cancelAtPeriodEnd!: boolean;
  public graceEndsAt?: Date | null;
  public renewalReminderSentAt?: Date | null;
  public paymentFailedEmailedAt?: Date | null;
  public stripeCustomerId?: string | null;
  public stripeSubscriptionId?: string | null;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Subscription.init(
  {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    userId: { type: DataTypes.INTEGER, allowNull: true },
    companyId: { type: DataTypes.INTEGER, allowNull: true },
    plan: { type: DataTypes.STRING(20), allowNull: false },
    interval: { type: DataTypes.STRING(10), allowNull: true },
    status: { type: DataTypes.STRING(20), allowNull: false },
    seats: { type: DataTypes.INTEGER, allowNull: true },
    trialEndsAt: { type: DataTypes.DATE, allowNull: true },
    trialReminderSentAt: { type: DataTypes.DATE, allowNull: true },
    currentPeriodEnd: { type: DataTypes.DATE, allowNull: true },
    cancelAtPeriodEnd: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    graceEndsAt: { type: DataTypes.DATE, allowNull: true },
    renewalReminderSentAt: { type: DataTypes.DATE, allowNull: true },
    paymentFailedEmailedAt: { type: DataTypes.DATE, allowNull: true },
    stripeCustomerId: { type: DataTypes.STRING(255), allowNull: true },
    stripeSubscriptionId: { type: DataTypes.STRING(255), allowNull: true, unique: true },
  },
  { sequelize, tableName: "subscriptions", timestamps: true }
);

export default Subscription;
