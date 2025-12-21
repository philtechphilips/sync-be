import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddedOnboardingPlanToWorkspace1766348963760
  implements MigrationInterface
{
  name = 'AddedOnboardingPlanToWorkspace1766348963760';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspaces" ADD "onboarding_plan" character varying NOT NULL DEFAULT 'starter'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspaces" DROP COLUMN "onboarding_plan"`,
    );
  }
}
