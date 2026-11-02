/**
 * Schemas, indexes and foreign keys across engines.
 * SYNQ_E2E=1 npm run test:e2e (see test/README.md)
 */
import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import * as mssql from 'mssql';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const run = process.env.SYNQ_E2E === '1' ? describe : describe.skip;
const withMssql = process.env.SYNQ_E2E_MSSQL !== '0';
const MYSQL = {
  host: '127.0.0.1',
  port: 33306,
  user: 'root',
  password: 'testpass',
};
const PG = {
  host: '127.0.0.1',
  port: 35432,
  user: 'postgres',
  password: 'testpass',
};
const MSSQL = {
  server: '127.0.0.1',
  port: 31433,
  user: 'sa',
  password: 'Test_pass123',
};

async function my(sql: string, database?: string) {
  const c = await mysql.createConnection({
    ...MYSQL,
    database,
    multipleStatements: true,
  });
  try {
    return (await c.query(sql))[0] as any;
  } finally {
    await c.end();
  }
}
async function pg(sql: string, database = 'testdb') {
  const c = new PgClient({ ...PG, database });
  await c.connect();
  try {
    return (await c.query(sql)).rows;
  } finally {
    await c.end();
  }
}
async function ms(sql: string, database = 'master') {
  const pool = await mssql.connect({
    ...MSSQL,
    database,
    options: { encrypt: true, trustServerCertificate: true },
  });
  try {
    return (await pool.request().query(sql)).recordset;
  } finally {
    await pool.close();
  }
}
async function freshMssqlDb(name: string) {
  await ms(
    `IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE ${name} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${name}; END`,
  );
  await ms(`CREATE DATABASE ${name}`);
}

run('schemas, indexes and foreign keys (e2e)', () => {
  let app: NestExpressApplication;
  let token = '';
  const api = {
    get: (url: string) =>
      request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) =>
      request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (url: string, body?: object) =>
      request(app.getHttpServer())
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    del: (url: string, body?: object) =>
      request(app.getHttpServer())
        .delete(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  };
  const cluster = async (body: Record<string, unknown>) => {
    const res = await api.post('/v1/clusters', body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  const pgCluster = (database: string) =>
    cluster({
      name: database,
      type: 'postgres',
      host: '127.0.0.1',
      port: 35432,
      username: 'postgres',
      password: 'testpass',
      database,
    });
  const myCluster = (database: string) =>
    cluster({
      name: database,
      type: 'mysql',
      host: '127.0.0.1',
      port: 33306,
      username: 'root',
      password: 'testpass',
      database,
    });
  const msCluster = (database: string) =>
    cluster({
      name: database,
      type: 'mssql',
      host: '127.0.0.1',
      port: 31433,
      username: 'sa',
      password: 'Test_pass123',
      database,
    });
  const rows = async (id: string, table: string) => {
    const res = await api.get(
      `/v1/clusters/${id}/tables/${encodeURIComponent(table)}?limit=1000`,
    );
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>[];
  };

  beforeAll(async () => {
    await my(
      'DROP DATABASE IF EXISTS synq_meta_test; CREATE DATABASE synq_meta_test;',
    );
    for (const db of ['synq_sch_src', 'synq_sch_pg', 'synq_sch_pg2']) {
      await pg(`DROP DATABASE IF EXISTS ${db}`);
      await pg(`CREATE DATABASE ${db}`);
    }
    await pg(
      `CREATE SCHEMA sales;
       CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);
       CREATE INDEX customers_email_lower ON customers (lower(email));
       CREATE TABLE sales.orders (
         id SERIAL PRIMARY KEY,
         customer_id INT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
         total NUMERIC(10,2) NOT NULL,
         created_at TIMESTAMP NOT NULL DEFAULT now()
       );
       CREATE INDEX orders_customer_created ON sales.orders (customer_id, created_at DESC);
       INSERT INTO customers (email, name) VALUES ('a@x.io', 'Ada'), ('b@x.io', 'Bob');
       INSERT INTO sales.orders (customer_id, total, created_at) VALUES (1, 10.50, '2026-01-01 10:00'), (2, 99.99, '2026-01-02 11:00');`,
      'synq_sch_src',
    );
    await my(
      `DROP DATABASE IF EXISTS synq_sch_my; CREATE DATABASE synq_sch_my;
       DROP DATABASE IF EXISTS synq_sch_mysrc; CREATE DATABASE synq_sch_mysrc;
       USE synq_sch_mysrc;
       CREATE TABLE authors (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, UNIQUE KEY uq_author_name (name));
       CREATE TABLE books (id INT AUTO_INCREMENT PRIMARY KEY, author_id INT, title VARCHAR(200), notes TEXT,
         KEY idx_books_title (title), KEY idx_books_notes (notes(50)),
         CONSTRAINT fk_books_author FOREIGN KEY (author_id) REFERENCES authors (id) ON DELETE SET NULL);
       INSERT INTO authors (name) VALUES ('Le Guin'), ('Butler');
       INSERT INTO books (author_id, title) VALUES (1, 'Earthsea'), (2, 'Kindred');`,
    );
    if (withMssql) {
      await freshMssqlDb('synqsch');
      await freshMssqlDb('synqschcopy');
      await freshMssqlDb('synqschsync');
      await ms(
        `EXEC('CREATE SCHEMA sales');
         CREATE TABLE dbo.customers (id INT IDENTITY(1,1) PRIMARY KEY, email NVARCHAR(200) NOT NULL CONSTRAINT uq_customers_email UNIQUE, age INT NULL CONSTRAINT ck_customers_age CHECK (age >= 0));
         CREATE TABLE sales.orders (id INT IDENTITY(1,1) PRIMARY KEY, customer_id INT NOT NULL CONSTRAINT fk_orders_customer REFERENCES dbo.customers (id), total DECIMAL(12,2) NOT NULL, status NVARCHAR(20) NULL);
         CREATE NONCLUSTERED INDEX ix_orders_customer ON sales.orders (customer_id DESC) INCLUDE (total) WHERE status IS NOT NULL;
         INSERT INTO dbo.customers (email, age) VALUES (N'a@x.io', 30), (N'b@x.io', NULL);
         INSERT INTO sales.orders (customer_id, total, status) VALUES (1, 12.50, N'paid'), (2, 7.25, NULL);`,
        'synqsch',
      );
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app);
    await app.init();
    await request(app.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: 's@example.com', password: 'correct horse' });
    token = (
      await request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 's@example.com', password: 'correct horse' })
    ).body.access_token;
  });

  afterAll(async () => {
    await app?.close();
  });

  let src = '';

  it('lists and edits tables outside the public schema', async () => {
    src = await pgCluster('synq_sch_src');
    const tables = (await api.get(`/v1/clusters/${src}/tables`)).body.map(
      (t: any) => t.name,
    );
    expect(tables).toEqual(['customers', 'sales.orders']);

    const cols = (
      await api.get(`/v1/clusters/${src}/tables/sales.orders/columns`)
    ).body;
    expect(cols.find((c: any) => c.name === 'customer_id')).toMatchObject({
      referencedTable: 'customers',
      referencedColumn: 'id',
    });

    const ins = await api.post(`/v1/clusters/${src}/tables/sales.orders`, {
      customer_id: 1,
      total: '5.00',
    });
    expect(ins.status).toBe(201);
    expect(ins.body).toMatchObject({ id: 3, total: '5.00' });
    expect(
      (
        await api.patch(`/v1/clusters/${src}/tables/sales.orders/rows`, {
          data: { total: '6.00' },
          where: { id: 3 },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.del(`/v1/clusters/${src}/tables/sales.orders/rows`, {
          where: { id: 3 },
        })
      ).body.affectedRows,
    ).toBe(1);
  });

  it('syncs Postgres to Postgres with schemas, data, indexes and foreign keys', async () => {
    const dst = await pgCluster('synq_sch_pg');
    const diff = (await api.get(`/v1/clusters/${src}/compare/${dst}`)).body;
    expect(diff.missingInTarget.map((t: any) => t.tableName).sort()).toEqual([
      'customers',
      'sales.orders',
    ]);

    // Child first on purpose: data must still be copied parents-first.
    const res = await api.post(`/v1/clusters/${src}/sync/${dst}`, {
      tableNames: ['sales.orders', 'customers'],
      withData: true,
    });
    expect(res.status).toBe(201);
    const [orders, customers] = res.body;
    expect(orders).toMatchObject({
      success: true,
      created: true,
      rowsCopied: 2,
      foreignKeysCreated: ['orders_customer_id_fkey'],
    });
    expect(orders.indexesCreated).toEqual(['orders_customer_created']);
    expect(customers.indexesCreated.sort()).toEqual([
      'customers_email_key',
      'customers_email_lower',
    ]);

    expect(await rows(dst, 'sales.orders')).toEqual(
      await rows(src, 'sales.orders'),
    );
    const fk = await pg(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'orders_customer_id_fkey'`,
      'synq_sch_pg',
    );
    expect(fk[0].def).toContain('ON DELETE CASCADE');
    const idx = await pg(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_customer_created'`,
      'synq_sch_pg',
    );
    expect(idx[0].indexdef).toContain('created_at DESC');

    const again = (await api.get(`/v1/clusters/${src}/compare/${dst}`)).body;
    expect(again.matchingTables.map((t: any) => t.tableName).sort()).toEqual([
      'customers',
      'sales.orders',
    ]);
  });

  it('syncs Postgres to MySQL, dropping schemas and skipping what MySQL cannot express', async () => {
    const dst = await myCluster('synq_sch_my');
    const res = await api.post(`/v1/clusters/${src}/sync/${dst}`, {
      tableNames: ['customers', 'sales.orders'],
      withData: true,
    });
    expect(res.status).toBe(201);
    const [customers, orders] = res.body;
    expect(orders.error).toBeNull();
    expect(customers).toMatchObject({
      success: true,
      created: true,
      rowsCopied: 2,
    });
    expect(customers.indexesCreated).toEqual(['customers_email_key']);
    expect(customers.notes.join(' ')).toContain('customers_email_lower');
    expect(orders).toMatchObject({
      success: true,
      rowsCopied: 2,
      foreignKeysCreated: ['orders_customer_id_fkey'],
    });

    const fks = await my(
      `SELECT REFERENCED_TABLE_NAME AS ref, DELETE_RULE AS onDelete FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = 'synq_sch_my'`,
    );
    expect(fks).toEqual([{ ref: 'customers', onDelete: 'CASCADE' }]);
    const uniques = await my(
      `SELECT INDEX_NAME AS name, SUB_PART AS prefix FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = 'synq_sch_my' AND TABLE_NAME = 'customers' AND INDEX_NAME <> 'PRIMARY'`,
    );
    expect(uniques).toEqual([{ name: 'customers_email_key', prefix: 191 }]); // TEXT key needs a prefix
    const total = await my(
      `SELECT total FROM orders ORDER BY id`,
      'synq_sch_my',
    );
    expect(total.map((r: any) => r.total)).toEqual(['10.50', '99.99']);
  });

  (withMssql ? it : it.skip)(
    'syncs MySQL to SQL Server with indexes and foreign keys',
    async () => {
      const srcMy = await myCluster('synq_sch_mysrc');
      const dst = await msCluster('synqschsync');
      const res = await api.post(`/v1/clusters/${srcMy}/sync/${dst}`, {
        tableNames: ['books', 'authors'],
        withData: true,
      });
      expect(res.status).toBe(201);
      const [books, authors] = res.body;
      expect(authors).toMatchObject({
        success: true,
        rowsCopied: 2,
        indexesCreated: ['uq_author_name'],
      });
      expect(books).toMatchObject({
        success: true,
        rowsCopied: 2,
        foreignKeysCreated: ['fk_books_author'],
      });
      // MySQL backs each foreign key with its own index; it is copied too.
      expect(books.indexesCreated.sort()).toEqual([
        'fk_books_author',
        'idx_books_title',
      ]);
      expect(books.notes.join(' ')).toContain('idx_books_notes'); // TEXT -> nvarchar(max) can't be a key

      const fk = await ms(
        `SELECT delete_referential_action_desc AS d FROM sys.foreign_keys WHERE name = 'fk_books_author'`,
        'synqschsync',
      );
      expect(fk[0].d).toBe('SET_NULL');
      expect(await rows(dst, 'books')).toEqual(await rows(srcMy, 'books'));
    },
  );

  (withMssql ? it : it.skip)(
    'round-trips SQL Server schemas, indexes and constraints through a backup',
    async () => {
      const srcMs = await msCluster('synqsch');
      expect(
        (await api.get(`/v1/clusters/${srcMs}/tables`)).body.map(
          (t: any) => t.name,
        ),
      ).toEqual(['customers', 'sales.orders']);

      const backup = await api.get(`/v1/clusters/${srcMs}/backup?format=sql`);
      expect(backup.status).toBe(200);
      const copy = await msCluster('synqschcopy');
      const restore = await api.post(`/v1/clusters/${copy}/restore`, {
        format: 'sql',
        data: { content: backup.body.content },
      });
      expect(restore.status).toBe(201);

      expect(await rows(copy, 'sales.orders')).toEqual(
        await rows(srcMs, 'sales.orders'),
      );
      const idx = await ms(
        `SELECT i.name, i.filter_definition AS f, i.is_unique_constraint AS uc FROM sys.indexes i
       WHERE i.name IN ('ix_orders_customer', 'uq_customers_email') ORDER BY i.name`,
        'synqschcopy',
      );
      expect(idx).toEqual([
        { name: 'ix_orders_customer', f: '([status] IS NOT NULL)', uc: false },
        { name: 'uq_customers_email', f: null, uc: true },
      ]);
      const included = await ms(
        `SELECT c.name FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.name = 'ix_orders_customer' AND ic.is_included_column = 1`,
        'synqschcopy',
      );
      expect(included).toEqual([{ name: 'total' }]);
      const checks = await ms(
        `SELECT name FROM sys.check_constraints`,
        'synqschcopy',
      );
      expect(checks).toEqual([{ name: 'ck_customers_age' }]);
      const fks = await ms(`SELECT name FROM sys.foreign_keys`, 'synqschcopy');
      expect(fks).toEqual([{ name: 'fk_orders_customer' }]);
      // Restoring the same backup again is a no-op for the schema objects.
      await ms(
        'DELETE FROM sales.orders; DELETE FROM dbo.customers;',
        'synqschcopy',
      );
      const twice = await api.post(`/v1/clusters/${copy}/restore`, {
        format: 'sql',
        data: { content: backup.body.content },
      });
      expect(twice.status).toBe(201);
    },
  );
});
