import { MigrationInterface, QueryRunner, Table } from 'typeorm';

/** Pending CLI logins move from process memory to the database (multi-instance). */
export class CliLoginRequests1793000000002 implements MigrationInterface {
  name = 'CliLoginRequests1793000000002';

  public async up(q: QueryRunner): Promise<void> {
    await q.createTable(
      new Table({
        name: 'cli_login_requests',
        columns: [
          { name: 'id', type: 'char', length: '64', isPrimary: true },
          { name: 'userCode', type: 'varchar', length: '16' },
          {
            name: 'hostname',
            type: 'varchar',
            length: '100',
            isNullable: true,
          },
          { name: 'ip', type: 'varchar', length: '64', isNullable: true },
          {
            name: 'status',
            type: 'varchar',
            length: '16',
            default: "'pending'",
          },
          { name: 'userId', type: 'varchar', length: '36', isNullable: true },
          { name: 'attempts', type: 'int', default: 0 },
          { name: 'expiresAt', type: 'datetime' },
          {
            name: 'created_at',
            type: 'datetime',
            precision: 6,
            default: 'CURRENT_TIMESTAMP(6)',
          },
        ],
      }),
      true,
    );
  }

  public async down(q: QueryRunner): Promise<void> {
    await q.dropTable('cli_login_requests', true);
  }
}
