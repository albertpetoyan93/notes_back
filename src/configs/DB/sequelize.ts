import { Sequelize } from "sequelize";
import EnvVars from "../../common/EnvVars";

interface IDBConfigs {
  DB_HOST: string;
  DB_PORT: string;
  DB_USER: string;
  DB_NAME: string;
  DB_PASSWORD: string;
}

const dbConfig: IDBConfigs = {
  DB_HOST: EnvVars.Db.Host,
  DB_PORT: EnvVars.Db.Port,
  DB_USER: EnvVars.Db.User,
  DB_PASSWORD: EnvVars.Db.Password,
  DB_NAME: EnvVars.Db.Database,
};

const { DB_HOST, DB_PORT, DB_USER, DB_NAME, DB_PASSWORD }: IDBConfigs =
  dbConfig;

const sequelize = new Sequelize(DB_NAME, DB_USER, DB_PASSWORD, {
  host: DB_HOST,
  port: Number(DB_PORT),
  dialect: "postgres",
  pool: {
    max: 10, // Max connections in pool
    min: 0, // Min connections
    idle: 10000, // Time before idle connection is closed
  },
  logging: false,
  // logging: console.log,
});

export default sequelize;
