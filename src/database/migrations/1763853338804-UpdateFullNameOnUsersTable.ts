import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateFullNameOnUsersTable1763853338804
  implements MigrationInterface
{
  name = 'UpdateFullNameOnUsersTable1763853338804';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_users" ALTER COLUMN "full_name" DROP NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "auth_users" ALTER COLUMN "full_name" SET NOT NULL`,
    );
  }
}
