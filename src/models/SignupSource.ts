import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface SignupSourceAttributes {
  userId: number;
  source: string | null;
  medium: string | null;
  campaign: string | null;
  content: string | null;
  referrerDomain: string | null;
  landingPath: string | null;
  createdAt?: Date;
}

type SignupSourceCreation = Optional<
  SignupSourceAttributes,
  "source" | "medium" | "campaign" | "content" | "referrerDomain" | "landingPath"
>;

/** Where an account came from; written once at sign-up. */
class SignupSource
  extends Model<SignupSourceAttributes, SignupSourceCreation>
  implements SignupSourceAttributes
{
  public userId!: number;
  public source!: string | null;
  public medium!: string | null;
  public campaign!: string | null;
  public content!: string | null;
  public referrerDomain!: string | null;
  public landingPath!: string | null;
  public readonly createdAt!: Date;
}

SignupSource.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    source: { type: DataTypes.STRING(100), allowNull: true },
    medium: { type: DataTypes.STRING(100), allowNull: true },
    campaign: { type: DataTypes.STRING(150), allowNull: true },
    content: { type: DataTypes.STRING(150), allowNull: true },
    referrerDomain: { type: DataTypes.STRING(255), allowNull: true },
    landingPath: { type: DataTypes.STRING(255), allowNull: true },
  },
  {
    sequelize,
    tableName: "signup_sources",
    timestamps: true,
    updatedAt: false,
  }
);

export default SignupSource;
