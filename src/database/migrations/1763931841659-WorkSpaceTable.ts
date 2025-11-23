import { MigrationInterface, QueryRunner } from 'typeorm';

export class WorkSpaceTable1763931841659 implements MigrationInterface {
  name = 'WorkSpaceTable1763931841659';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "workspace_members" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "workspace_id" uuid NOT NULL, "user_id" uuid, "email" character varying NOT NULL, "role" character varying NOT NULL DEFAULT 'member', "can_invite_teammates" boolean NOT NULL DEFAULT false, "can_manage_settings" boolean NOT NULL DEFAULT false, "can_view_analytics" boolean NOT NULL DEFAULT false, "invitation_token" character varying, "invitation_sent_at" TIMESTAMP, "invitation_accepted_at" TIMESTAMP, "invitation_expires_at" TIMESTAMP, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_8a19209e974992c7a01f121d0cf" UNIQUE ("invitation_token"), CONSTRAINT "PK_22ab43ac5865cd62769121d2bc4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4a7c584ddfe855379598b5e20f" ON "workspace_members" ("workspace_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4e83431119fa585fc7aa8b817d" ON "workspace_members" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8a19209e974992c7a01f121d0c" ON "workspace_members" ("invitation_token") `,
    );
    await queryRunner.query(
      `CREATE TABLE "workspaces" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "industry_type" character varying NOT NULL, "workspace_url" character varying NOT NULL, "description" text, "unique_key" character varying NOT NULL, "default_language" character varying NOT NULL DEFAULT 'en', "default_currency" character varying NOT NULL DEFAULT 'USD', "default_timezone" character varying NOT NULL DEFAULT 'UTC', "theme" character varying NOT NULL DEFAULT 'light', "created_by" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "UQ_5231bf8d0d63622937b83ea34a2" UNIQUE ("workspace_url"), CONSTRAINT "UQ_845271d9ec1e57bda19d404bfd3" UNIQUE ("unique_key"), CONSTRAINT "PK_098656ae401f3e1a4586f47fd8e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5231bf8d0d63622937b83ea34a" ON "workspaces" ("workspace_url") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_845271d9ec1e57bda19d404bfd" ON "workspaces" ("unique_key") `,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" ADD CONSTRAINT "FK_4a7c584ddfe855379598b5e20fd" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" ADD CONSTRAINT "FK_4e83431119fa585fc7aa8b817db" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "workspace_members" DROP CONSTRAINT "FK_4e83431119fa585fc7aa8b817db"`,
    );
    await queryRunner.query(
      `ALTER TABLE "workspace_members" DROP CONSTRAINT "FK_4a7c584ddfe855379598b5e20fd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_845271d9ec1e57bda19d404bfd"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5231bf8d0d63622937b83ea34a"`,
    );
    await queryRunner.query(`DROP TABLE "workspaces"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8a19209e974992c7a01f121d0c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4e83431119fa585fc7aa8b817d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4a7c584ddfe855379598b5e20f"`,
    );
    await queryRunner.query(`DROP TABLE "workspace_members"`);
  }
}
