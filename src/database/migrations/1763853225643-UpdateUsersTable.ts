import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateUsersTable1763853225643 implements MigrationInterface {
  name = 'UpdateUsersTable1763853225643';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_users" ADD "access_token" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_users" ADD "refresh_token" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_users" ADD "refresh_token_expiry" TIMESTAMP`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_users" DROP COLUMN "refresh_token_expiry"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_users" DROP COLUMN "refresh_token"`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_users" DROP COLUMN "access_token"`,
    );
  }
}
