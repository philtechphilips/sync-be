import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddLocalAgentToCluster1744380000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`clusters\` ADD COLUMN \`is_local\` tinyint(1) NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE \`clusters\` ADD COLUMN \`agent_key\` varchar(64) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`clusters\` ADD UNIQUE INDEX \`UQ_clusters_agent_key\` (\`agent_key\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`clusters\` DROP INDEX \`UQ_clusters_agent_key\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`clusters\` DROP COLUMN \`agent_key\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`clusters\` DROP COLUMN \`is_local\``,
    );
  }
}
