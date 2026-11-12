import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { BaselineAndHardening1793000000000 } from './migrations/1793000000000-BaselineAndHardening';
import { AgentConnections1793000000001 } from './migrations/1793000000001-AgentConnections';

/**
 * The previous release used TypeORM `synchronize: true`, which reshapes the
 * tables to its own model whenever it starts. If a copy of it starts against
 * this database after the migrations ran, it drops their columns
 * (auth_users.email_verified, clusters.sslMode, clusters.agentConnection),
 * the unique email index and the cascading foreign keys, and logins fail.
 *
 * Migrations run only once, so on every start this re-runs the schema steps.
 * Each one checks before changing anything; on a correct schema it only reads.
 */
@Injectable()
export class SchemaGuard implements OnModuleInit {
  private readonly logger = new Logger(SchemaGuard.name);

  constructor(private readonly dataSource: DataSource) {}

  async onModuleInit() {
    const q = this.dataSource.createQueryRunner();
    try {
      const before = await this.missing(q);
      if (before.length === 0) return;
      this.logger.warn(
        `Schema was changed by an older release (missing: ${before.join(', ')}). Restoring it. Make sure only this version runs against the database.`,
      );
      await new BaselineAndHardening1793000000000().up(q);
      await new AgentConnections1793000000001().up(q);
    } catch (e) {
      this.logger.error(
        `Could not restore the schema: ${(e as Error).message}`,
      );
    } finally {
      await q.release();
    }
  }

  private async missing(q: ReturnType<DataSource['createQueryRunner']>) {
    const checks: [string, string][] = [
      ['auth_users', 'email_verified'],
      ['clusters', 'sslMode'],
      ['clusters', 'agentConnection'],
    ];
    const gone: string[] = [];
    for (const [table, column] of checks) {
      if (!(await q.hasColumn(table, column))) gone.push(`${table}.${column}`);
    }
    if (await q.hasColumn('auth_users', 'refresh_token'))
      gone.push('auth_users.refresh_token (legacy column back)');
    return gone;
  }
}
