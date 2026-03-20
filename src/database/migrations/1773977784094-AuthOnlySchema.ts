import { MigrationInterface, QueryRunner } from "typeorm";

export class AuthOnlySchema1773977784094 implements MigrationInterface {
    name = 'AuthOnlySchema1773977784094'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE \`auth_users\` (\`id\` varchar(36) NOT NULL, \`full_name\` varchar(255) NULL, \`requires_password\` tinyint NOT NULL DEFAULT 1, \`password\` varchar(255) NULL, \`email\` varchar(255) NOT NULL, \`role\` varchar(255) NOT NULL DEFAULT 'user', \`access_token\` varchar(255) NULL, \`refresh_token\` varchar(255) NULL, \`refresh_token_expiry\` timestamp NULL, \`profile_picture\` varchar(255) NULL, \`provider\` varchar(255) NULL DEFAULT 'local', \`google_id\` varchar(255) NULL, \`created_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updated_at\` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE \`auth_users\``);
    }

}
