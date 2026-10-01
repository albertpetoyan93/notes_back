import { DataTypes, Model, Optional } from "sequelize";
import sequelize from "../configs/DB/sequelize";

export type CompanyStatus = "active" | "suspended";

interface CompanyAttributes {
  id: number;
  name: string;
  status: CompanyStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

type CompanyCreation = Optional<CompanyAttributes, "id" | "status" | "createdAt" | "updatedAt">;

class Company extends Model<CompanyAttributes, CompanyCreation> implements CompanyAttributes {
  public id!: number;
  public name!: string;
  public status!: CompanyStatus;
  public readonly createdAt!: Date;
  public readonly updatedAt!: Date;
}

Company.init(
  {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM("active", "suspended"),
      allowNull: false,
      defaultValue: "active",
    },
  },
  {
    sequelize,
    tableName: "companies",
    timestamps: true,
  }
);

export default Company;
