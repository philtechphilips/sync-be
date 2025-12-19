import { config } from 'src/config/config.service';
import { DataSource, DataSourceOptions } from 'typeorm';

export const datasourceOptions: DataSourceOptions = {
  type: 'postgres',
  url: config.DB.URL,

  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/database/migrations/*.js'],
  ssl: {
    rejectUnauthorized: false,
  },
};

const dataSource = new DataSource(datasourceOptions);

export default dataSource;
