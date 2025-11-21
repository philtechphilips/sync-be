import { MigrationInterface, QueryRunner } from "typeorm";

export class Migrations1763749221205 implements MigrationInterface {
    name = 'Migrations1763749221205'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "auth_users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "full_name" character varying NOT NULL, "requires_password" boolean NOT NULL DEFAULT true, "password" character varying, "email" character varying NOT NULL, "role" character varying NOT NULL DEFAULT 'user', "profile_picture" character varying, "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_c88cc8077366b470dafc2917366" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "auth_users"`);
    }

}
