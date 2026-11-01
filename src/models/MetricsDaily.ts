import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type MrrByPlan = { premium: number; family: number; team: number };

interface MetricsDailyAttributes {
  /** YYYY-MM-DD, UTC. */
  date: string;
  signups: number;
  dau: number;
  wau: number;
  mau: number;
  paying: number;
  trials: number;
  mrrCents: number;
  churned: number;
  activatedFirstItem: number;
  activatedExtension: number;
  activatedAutofill: number;
  mrrByPlan: MrrByPlan;
  createdAt?: Date;
}

type MetricsDailyCreation = Optional<MetricsDailyAttributes, "createdAt">;

class MetricsDaily
  extends Model<MetricsDailyAttributes, MetricsDailyCreation>
  implements MetricsDailyAttributes
{
  public date!: string;
  public signups!: number;
  public dau!: number;
  public wau!: number;
  public mau!: number;
  public paying!: number;
  public trials!: number;
  public mrrCents!: number;
  public churned!: number;
  public activatedFirstItem!: number;
  public activatedExtension!: number;
  public activatedAutofill!: number;
  public mrrByPlan!: MrrByPlan;
  public readonly createdAt!: Date;
}

MetricsDaily.init(
  {
    date: { type: DataTypes.DATEONLY, primaryKey: true },
    signups: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    dau: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    wau: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    mau: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    paying: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    trials: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    mrrCents: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    churned: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    activatedFirstItem: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    activatedExtension: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    activatedAutofill: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    mrrByPlan: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: { premium: 0, family: 0, team: 0 },
    },
    createdAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  {
    sequelize,
    tableName: "metrics_daily",
    timestamps: false,
    updatedAt: false,
  }
);

export default MetricsDaily;
