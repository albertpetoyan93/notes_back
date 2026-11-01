import { DataTypes, Model } from "sequelize";
import sequelize from "../configs/DB/sequelize";

interface UserActivityDayAttributes {
  userId: number;
  /** YYYY-MM-DD, UTC. */
  date: string;
  web: boolean;
  extension: boolean;
}

class UserActivityDay
  extends Model<UserActivityDayAttributes, UserActivityDayAttributes>
  implements UserActivityDayAttributes
{
  public userId!: number;
  public date!: string;
  public web!: boolean;
  public extension!: boolean;
}

UserActivityDay.init(
  {
    userId: { type: DataTypes.INTEGER, primaryKey: true },
    date: { type: DataTypes.DATEONLY, primaryKey: true },
    web: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    extension: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  {
    sequelize,
    tableName: "user_activity_days",
    timestamps: false,
  }
);

export default UserActivityDay;
