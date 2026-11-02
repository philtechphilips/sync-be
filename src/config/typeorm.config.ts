import { join } from 'path';
import { config } from './config.service';
import { DataSource, DataSourceOptions } from 'typeorm';
import { User } from '../auth/entities/user.entity';
import { AuthSession } from '../auth/entities/auth-session.entity';
import { CliLoginRequest } from '../auth/entities/cli-login-request.entity';
import { Cluster } from '../clusters/entities/cluster.entity';
import { QueryLog } from '../clusters/entities/query-log.entity';
import { Collection } from '../query-management/entities/collection.entity';
import { SavedQuery } from '../query-management/entities/saved-query.entity';

export const datasourceOptions: DataSourceOptions = {
  type: 'mysql',
  host: config.DB.HOST,
  port: config.DB.PORT,
  username: config.DB.USERNAME,
  password: config.DB.PASSWORD,
  database: config.DB.NAME,
  entities: [
    User,
    AuthSession,
    CliLoginRequest,
    Cluster,
    QueryLog,
    Collection,
    SavedQuery,
  ],
  // .js when compiled (dist also holds .d.ts files), .ts under ts-jest.
  migrations: [
    join(
      __dirname,
      '..',
      'database',
      'migrations',
      `*.${__filename.endsWith('.ts') ? 'ts' : 'js'}`,
    ),
  ],
  // Schema changes go through migrations only; they run on startup.
  synchronize: false,
  migrationsRun: true,
};

const dataSource = new DataSource(datasourceOptions);

export default dataSource;
