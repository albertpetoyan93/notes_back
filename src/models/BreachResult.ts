import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

/** How often a login's password appeared in known leaks, as last checked. */
interface BreachResultAttributes {
  id: number;
  userId: number;
  noteId: number;
  /** Times the password appears in Have I Been Pwned; 0 when it doesn't. */
  count: number;
  checkedAt: Date;
}

type BreachResultCreation = Optional<BreachResultAttributes, "id" | "count" | "checkedAt">;

class BreachResult
  extends Model<BreachResultAttributes, BreachResultCreation>
  implements BreachResultAttributes
{
  public id!: number;
  public userId!: number;
  public noteId!: number;
  public count!: number;
  public checkedAt!: Date;
}

BreachResult.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    noteId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    checkedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    sequelize,
    tableName: "breach_results",
    timestamps: false,
    indexes: [{ unique: true, fields: ["userId", "noteId"] }],
  }
);

export default BreachResult;
