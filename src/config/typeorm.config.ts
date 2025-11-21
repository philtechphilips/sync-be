import { config } from 'src/config/config.service';
import { DataSource, DataSourceOptions } from 'typeorm';

export const datasourceOptions: DataSourceOptions = {
  type: 'postgres',
  host: config.DB.HOST,
  port: config.DB.PORT,
  username: config.DB.USER,
  password: config.DB.PASSWORD,
  database: config.DB.NAME,
  entities: ['dist/**/*.entity.js'],
  extra: {
    trustServerCertificate: true,
  },
  migrations: ['dist/database/migrations/*.js'],
};

const dataSource = new DataSource(datasourceOptions);

export default dataSource;
