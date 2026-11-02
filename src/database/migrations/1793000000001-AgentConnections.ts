import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/** Local clusters can reference a connection saved on the agent instead of storing credentials. */
export class AgentConnections1793000000001 implements MigrationInterface {
  name = 'AgentConnections1793000000001';

  public async up(q: QueryRunner): Promise<void> {
    if (!(await q.hasColumn('clusters', 'agentConnection'))) {
      await q.addColumn(
        'clusters',
        new TableColumn({
          name: 'agentConnection',
          type: 'varchar',
          length: '100',
          isNullable: true,
        }),
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    if (await q.hasColumn('clusters', 'agentConnection')) {
      await q.dropColumn('clusters', 'agentConnection');
    }
  }
}
