import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddProviderAndGoogleIdToUsersTable1763854000000
  implements MigrationInterface
{
  name = 'AddProviderAndGoogleIdToUsersTable1763854000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_users" ADD COLUMN "provider" VARCHAR DEFAULT 'local'`,
    );
    await queryRunner.query(
      `ALTER TABLE "auth_users" ADD COLUMN "google_id" VARCHAR`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "auth_users" DROP COLUMN "google_id"`);
    await queryRunner.query(`ALTER TABLE "auth_users" DROP COLUMN "provider"`);
  }
}
