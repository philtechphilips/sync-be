import { Logger } from '@nestjs/common';
import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableColumnOptions,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

const id: TableColumnOptions = {
  name: 'id',
  type: 'varchar',
  length: '36',
  isPrimary: true,
};
const createdAt: TableColumnOptions = {
  name: 'created_at',
  type: 'datetime',
  precision: 6,
  default: 'CURRENT_TIMESTAMP(6)',
};
const updatedAt: TableColumnOptions = {
  name: 'updated_at',
  type: 'datetime',
  precision: 6,
  default: 'CURRENT_TIMESTAMP(6)',
  onUpdate: 'CURRENT_TIMESTAMP(6)',
};
const varchar = (
  name: string,
  extra: Partial<TableColumnOptions> = {},
): TableColumnOptions => ({
  name,
  type: 'varchar',
  length: '255',
  ...extra,
});
const text = (name: string, isNullable = false): TableColumnOptions => ({
  name,
  type: 'text',
  isNullable,
});
const bool = (name: string, def: boolean): TableColumnOptions => ({
  name,
  type: 'tinyint',
  default: def ? 1 : 0,
});

/**
 * Baseline for databases created by the old `synchronize: true` setting,
 * plus the security/data fixes. Every step checks the current schema first,
 * so it is safe on both a fresh database and an existing production one.
 */
export class BaselineAndHardening1793000000000 implements MigrationInterface {
  name = 'BaselineAndHardening1793000000000';
  private readonly logger = new Logger('Migration');

  public async up(q: QueryRunner): Promise<void> {
    // ── Baseline tables (skipped when they already exist) ────────────────
    await q.createTable(
      new Table({
        name: 'auth_users',
        columns: [
          id,
          varchar('full_name', { isNullable: true }),
          varchar('email'),
          varchar('role', { default: "'user'" }),
          text('profile_picture', true),
          bool('requires_password', true),
          varchar('password', { isNullable: true }),
          bool('email_verified', false),
          varchar('provider', { isNullable: true, default: "'local'" }),
          varchar('google_id', { isNullable: true }),
          text('settings', true),
          varchar('agentKey', {
            length: '64',
            isNullable: true,
            isUnique: true,
          }),
          createdAt,
          updatedAt,
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'clusters',
        columns: [
          id,
          createdAt,
          updatedAt,
          varchar('userId'),
          text('name'),
          {
            name: 'type',
            type: 'enum',
            enum: ['mysql', 'postgres', 'mssql', 'sqlite'],
            default: "'mysql'",
          },
          text('host'),
          { name: 'port', type: 'int', default: 3306 },
          text('username'),
          text('password', true),
          text('database'),
          {
            name: 'environment',
            type: 'enum',
            enum: ['development', 'staging', 'production'],
            default: "'development'",
          },
          text('color', true),
          bool('isLocal', false),
          varchar('sslMode', { length: '16', default: "'prefer'" }),
        ],
        foreignKeys: [
          {
            columnNames: ['userId'],
            referencedTableName: 'auth_users',
            referencedColumnNames: ['id'],
          },
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'query_logs',
        columns: [
          id,
          text('query'),
          varchar('clusterId'),
          varchar('userId'),
          { name: 'executionTimeMs', type: 'int', isNullable: true },
          bool('success', true),
          text('errorMessage', true),
          createdAt,
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'collections',
        columns: [
          id,
          createdAt,
          updatedAt,
          varchar('userId'),
          varchar('name'),
          varchar('parentId', { isNullable: true }),
        ],
        foreignKeys: [
          {
            columnNames: ['userId'],
            referencedTableName: 'auth_users',
            referencedColumnNames: ['id'],
          },
          {
            columnNames: ['parentId'],
            referencedTableName: 'collections',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );

    await q.createTable(
      new Table({
        name: 'saved_queries',
        columns: [
          id,
          createdAt,
          updatedAt,
          varchar('userId'),
          varchar('name'),
          text('query'),
          varchar('clusterId', { isNullable: true }),
          varchar('collectionId', { isNullable: true }),
          text('tags', true),
        ],
        foreignKeys: [
          {
            columnNames: ['userId'],
            referencedTableName: 'auth_users',
            referencedColumnNames: ['id'],
          },
          {
            columnNames: ['clusterId'],
            referencedTableName: 'clusters',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
          {
            columnNames: ['collectionId'],
            referencedTableName: 'collections',
            referencedColumnNames: ['id'],
            onDelete: 'SET NULL',
          },
        ],
      }),
      true,
    );

    // ── Sessions (refresh tokens move out of auth_users) ─────────────────
    await q.createTable(
      new Table({
        name: 'auth_sessions',
        columns: [
          id,
          { name: 'userId', type: 'varchar', length: '36' },
          { name: 'tokenHash', type: 'char', length: '64' },
          {
            name: 'previousTokenHash',
            type: 'char',
            length: '64',
            isNullable: true,
          },
          { name: 'rotatedAt', type: 'datetime', isNullable: true },
          { name: 'expiresAt', type: 'datetime' },
          varchar('userAgent', { isNullable: true }),
          varchar('ip', { length: '64', isNullable: true }),
          createdAt,
        ],
        indices: [
          { name: 'IDX_auth_sessions_userId', columnNames: ['userId'] },
        ],
        foreignKeys: [
          {
            columnNames: ['userId'],
            referencedTableName: 'auth_users',
            referencedColumnNames: ['id'],
            onDelete: 'CASCADE',
          },
        ],
      }),
      true,
    );

    // ── auth_users hardening ─────────────────────────────────────────────
    if (!(await q.hasColumn('auth_users', 'email_verified'))) {
      await q.addColumn(
        'auth_users',
        new TableColumn(bool('email_verified', false)),
      );
      // Google already verified these addresses.
      await q.query(
        'UPDATE `auth_users` SET `email_verified` = 1 WHERE `google_id` IS NOT NULL',
      );
    }
    for (const legacy of [
      'access_token',
      'refresh_token',
      'refresh_token_expiry',
    ]) {
      if (await q.hasColumn('auth_users', legacy))
        await q.dropColumn('auth_users', legacy);
    }

    const users = await q.getTable('auth_users');
    const emailUnique =
      users?.indices.some(
        (i) =>
          i.isUnique &&
          i.columnNames.length === 1 &&
          i.columnNames[0] === 'email',
      ) ||
      users?.uniques.some(
        (u) => u.columnNames.length === 1 && u.columnNames[0] === 'email',
      );
    if (!emailUnique) {
      const duplicates: unknown[] = await q.query(
        'SELECT LOWER(`email`) AS email FROM `auth_users` GROUP BY LOWER(`email`) HAVING COUNT(*) > 1',
      );
      if (duplicates.length === 0) {
        await q.createIndex(
          'auth_users',
          new TableIndex({
            name: 'IDX_auth_users_email_unique',
            columnNames: ['email'],
            isUnique: true,
          }),
        );
      } else {
        this.logger.warn(
          `Skipped unique index on auth_users.email: ${duplicates.length} duplicated address(es) need merging first.`,
        );
      }
    }

    // ── clusters.sslMode ─────────────────────────────────────────────────
    if (!(await q.hasColumn('clusters', 'sslMode'))) {
      await q.addColumn(
        'clusters',
        new TableColumn(
          varchar('sslMode', { length: '16', default: "'prefer'" }),
        ),
      );
    }

    // ── query_logs: deleting a cluster or user removes its history ───────
    const logs = await q.getTable('query_logs');
    for (const [column, refTable] of [
      ['clusterId', 'clusters'],
      ['userId', 'auth_users'],
    ] as const) {
      const fk = logs?.foreignKeys.find(
        (f) => f.columnNames.length === 1 && f.columnNames[0] === column,
      );
      if (fk && fk.onDelete === 'CASCADE') continue;
      if (fk) await q.dropForeignKey('query_logs', fk);
      await q.query(
        `DELETE l FROM \`query_logs\` l LEFT JOIN \`${refTable}\` r ON r.\`id\` = l.\`${column}\` WHERE r.\`id\` IS NULL`,
      );
      await q.createForeignKey(
        'query_logs',
        new TableForeignKey({
          columnNames: [column],
          referencedTableName: refTable,
          referencedColumnNames: ['id'],
          onDelete: 'CASCADE',
        }),
      );
    }
  }

  public async down(q: QueryRunner): Promise<void> {
    // Only the hardening changes are reverted; baseline tables hold user data.
    await q.dropTable('auth_sessions', true);
    if (await q.hasColumn('clusters', 'sslMode'))
      await q.dropColumn('clusters', 'sslMode');
    if (await q.hasColumn('auth_users', 'email_verified')) {
      await q.dropColumn('auth_users', 'email_verified');
    }
  }
}
