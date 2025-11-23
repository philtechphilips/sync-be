import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateWorkSpaceTable1763933465560 implements MigrationInterface {
  name = 'UpdateWorkSpaceTable1763933465560';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspace_members" DROP COLUMN "can_invite_teammates"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" DROP COLUMN "can_manage_settings"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" DROP COLUMN "can_view_analytics"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "can_invite_teammates" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "can_manage_settings" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "can_view_analytics" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspaces" DROP COLUMN "can_view_analytics"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspaces" DROP COLUMN "can_manage_settings"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspaces" DROP COLUMN "can_invite_teammates"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" ADD "can_view_analytics" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" ADD "can_manage_settings" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" ADD "can_invite_teammates" boolean NOT NULL DEFAULT false`,
    );
  }
}
