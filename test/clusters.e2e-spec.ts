/**
 * End-to-end tests against real databases. Start the containers described
 * in test/README.md, then run: SYNQ_E2E=1 npm run test:e2e
 */
process.env.TZ = 'Africa/Lagos'; // UTC+1: the timezone where dates used to drift

import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import * as mssql from 'mssql';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { config } from '../src/config/config.service';

const run = process.env.SYNQ_E2E === '1' ? describe : describe.skip;

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
const withMssql = process.env.SYNQ_E2E_MSSQL !== '0';

async function mysqlAdmin(sql: string, database?: string) {
  const conn = await mysql.createConnection({
    ...MYSQL,
    database,
    multipleStatements: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  try {
    const [rows] = await conn.query(sql);
    return rows as any;
  } finally {
    await conn.end();
  }
}

async function pgAdmin(sql: string, database = 'testdb') {
  const client = new PgClient({ ...PG, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}

async function mssqlAdmin(sql: string, database = 'master') {
  const pool = await mssql.connect({
    ...MSSQL,
    database,
    options: { encrypt: true, trustServerCertificate: true },
  });
  try {
    return await pool.request().query(sql);
  } finally {
    await pool.close();
  }
}

run('SynqDB API (e2e)', () => {
  let app: NestExpressApplication;
  let agent: ReturnType<typeof request.agent>;
  let token: string;
  let userId: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createCluster(body: Record<string, unknown>) {
    const res = await agent.post('/v1/clusters').set(auth()).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  }
  const api = {
    get: (url: string) => agent.get(url).set(auth()),
    post: (url: string, body?: unknown) =>
      agent
        .post(url)
        .set(auth())
        .send(body as object),
    patch: (url: string, body?: unknown) =>
      agent
        .patch(url)
        .set(auth())
        .send(body as object),
    del: (url: string, body?: unknown) =>
      agent
        .delete(url)
        .set(auth())
        .send(body as object),
  };
  const rowsOf = async (clusterId: string, table: string) => {
    const res = await api.get(
      `/v1/clusters/${clusterId}/tables/${table}?limit=1000`,
    );
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>[];
  };

  beforeAll(async () => {
    // Metadata database for the app itself, recreated every run.
    await mysqlAdmin(
      `DROP DATABASE IF EXISTS synq_meta_test; CREATE DATABASE synq_meta_test;`,
    );

    // MySQL source + empty restore/sync targets
    await mysqlAdmin(
      `DROP DATABASE IF EXISTS synq_src; DROP DATABASE IF EXISTS synq_copy; CREATE DATABASE synq_src; CREATE DATABASE synq_copy;`,
    );
    await mysqlAdmin(
      `CREATE TABLE items (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        meta JSON NULL,
        tags JSON NULL,
        born DATE NULL,
        seen_at DATETIME(3) NULL,
        big BIGINT NULL,
        price DECIMAL(10,4) NULL,
        active TINYINT(1) NOT NULL DEFAULT 1,
        raw VARBINARY(16) NULL,
        note TEXT NULL
      );
      INSERT INTO items (name, meta, tags, born, seen_at, big, price, active, raw, note) VALUES
        ('alpha', '{"a":1,"b":"x;y"}', '[1,2,3]', '2026-11-02', '2026-11-02 08:30:00.123', 9007199254740993, 12.3400, 1, X'dead', 'semi;colon ''quote'' and \\\\ backslash'),
        ('beta', '"just a string"', NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL),
        ('gamma', NULL, '[]', '1999-12-31', '1999-12-31 23:59:59.000', -5, -0.5000, 1, X'00ff', 'line1\\nline2,comma "dq"');
      CREATE TABLE kids (id INT PRIMARY KEY, item_id INT, FOREIGN KEY (item_id) REFERENCES items(id));
      INSERT INTO kids VALUES (1, 1);
      CREATE TABLE logs_nopk (msg VARCHAR(50), n INT NULL);
      INSERT INTO logs_nopk VALUES ('dup', 1), ('dup', 1), ('other', NULL);`,
      'synq_src',
    );

    // Postgres source + empty targets
    for (const db of ['synq_pg_src', 'synq_pg_copy', 'synq_pg_sync']) {
      await pgAdmin(`DROP DATABASE IF EXISTS ${db}`);
      await pgAdmin(`CREATE DATABASE ${db}`);
    }
    await pgAdmin(
      `CREATE TYPE mood AS ENUM ('happy', 'sad');
       CREATE TABLE items (
         id SERIAL PRIMARY KEY,
         name VARCHAR(100) NOT NULL,
         meta JSONB,
         tags TEXT[],
         born DATE,
         seen_at TIMESTAMP(3),
         seen_tz TIMESTAMPTZ,
         big BIGINT,
         price NUMERIC(10,4),
         active BOOLEAN NOT NULL DEFAULT true,
         raw BYTEA,
         feeling mood,
         note TEXT,
         uid UUID DEFAULT gen_random_uuid()
       );
       CREATE INDEX items_name_idx ON items (name);
       INSERT INTO items (name, meta, tags, born, seen_at, seen_tz, big, price, active, raw, feeling, note) VALUES
         ('alpha', '{"a": [1, 2]}', ARRAY['x', 'y,z'], '2026-11-02', '2026-11-02 08:30:00.123', '2026-11-02 08:30:00+01', 9007199254740993, 12.34, true, '\\xdead', 'happy', E'semi;colon ''q'' \\\\ back'),
         ('beta', '"str"', '{}', NULL, NULL, NULL, NULL, NULL, false, NULL, NULL, NULL);
       CREATE TABLE kids (id INT PRIMARY KEY, item_id INT REFERENCES items (id));
       INSERT INTO kids VALUES (1, 1);`,
      'synq_pg_src',
    );

    if (withMssql) {
      await mssqlAdmin(
        `IF DB_ID('synqtest') IS NOT NULL BEGIN ALTER DATABASE synqtest SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE synqtest; END`,
      );
      await mssqlAdmin(
        `IF DB_ID('synqcopy') IS NOT NULL BEGIN ALTER DATABASE synqcopy SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE synqcopy; END`,
      );
      await mssqlAdmin('CREATE DATABASE synqtest');
      await mssqlAdmin('CREATE DATABASE synqcopy');
      await mssqlAdmin(
        `CREATE TABLE items (
           id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(100) NOT NULL, born DATE NULL,
           seen_at DATETIME2(3) NULL, big BIGINT NULL, price DECIMAL(20,6) NULL, cash MONEY NULL,
           active BIT NOT NULL DEFAULT 1, raw VARBINARY(16) NULL, note NVARCHAR(MAX) NULL);
         INSERT INTO items (name, born, seen_at, big, price, cash, active, raw, note) VALUES
           (N'alpha', '2026-11-02', '2026-11-02T08:30:00.123', 9007199254740993, 12345678901234.123456, 12.3456, 1, 0xdead, N'semi;colon ''q'''),
           (N'beta', NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL);
         CREATE TABLE kids (id INT PRIMARY KEY, item_id INT REFERENCES items (id));
         INSERT INTO kids VALUES (1, 1);`,
        'synqtest',
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
    agent = request.agent(app.getHttpServer());
  });

  afterAll(async () => {
    await app?.close();
  });

  // ─── Auth ──────────────────────────────────────────────────────────────

  it('ignores a role sent at registration', async () => {
    const res = await agent.post('/v1/auth/register').send({
      email: 'Owner@Example.com',
      password: 'correct horse',
      role: 'admin',
      agentKey: 'x',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.role).toBe('user');
    expect(res.body.data.email).toBe('owner@example.com');
    expect(res.body.data.password).toBeUndefined();
    const [row] = await mysqlAdmin(
      `SELECT role, agentKey FROM auth_users`,
      'synq_meta_test',
    );
    expect(row.role).toBe('user');
    expect(row.agentKey).not.toBe('x');
  });

  it('logs in with an httpOnly refresh cookie and refreshes from it', async () => {
    const bad = await agent
      .post('/v1/auth/login')
      .send({ email: 'nobody@example.com', password: 'whatever1' });
    const wrong = await agent
      .post('/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'wrong pass' });
    expect(bad.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(bad.body.message).toBe(wrong.body.message); // no account probing

    const res = await agent
      .post('/v1/auth/login')
      .send({ email: 'owner@example.com', password: 'correct horse' });
    expect(res.status).toBe(200);
    expect(res.body.refresh_token).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/synq_rt=.+HttpOnly/i);
    token = res.body.access_token;
    userId = res.body.user.id;

    const refreshed = await agent.post('/v1/auth/refresh').send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.access_token).toBeTruthy();
    expect(refreshed.body.user.email).toBe('owner@example.com');
  });

  it('refuses non-access tokens and keeps profile updates to safe fields', async () => {
    const jwt = app.get(JwtService);
    const reset = jwt.sign(
      { id: userId, sub: userId, type: 'password_reset' },
      { secret: config.JWT.SECRET },
    );
    const legacy = jwt.sign(
      { id: userId, role: 'user' },
      { secret: config.JWT.SECRET },
    );
    for (const t of [reset, legacy]) {
      const res = await agent
        .get('/v1/auth/status')
        .set({ Authorization: `Bearer ${t}` });
      expect(res.status).toBe(401);
    }
    const res = await api.patch('/v1/auth', {
      full_name: 'Owner',
      role: 'admin',
      email: 'evil@example.com',
      password: 'x',
    });
    expect(res.status).toBe(200);
    const [row] = await mysqlAdmin(
      `SELECT role, email, full_name FROM auth_users`,
      'synq_meta_test',
    );
    expect(row).toMatchObject({
      role: 'user',
      email: 'owner@example.com',
      full_name: 'Owner',
    });
  });

  it('requires the terminal code to authorize a CLI login', async () => {
    const init = await agent
      .post('/v1/auth/cli-login/init')
      .send({ hostname: 'laptop' });
    expect(init.body.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const info = await api.get(
      `/v1/auth/cli-login/info/${init.body.loginToken}`,
    );
    expect(info.body.hostname).toBe('laptop');
    expect(info.body.userCode).toBeUndefined();
    const wrong = await api.post('/v1/auth/cli-login/authorize', {
      loginToken: init.body.loginToken,
      userCode: 'AAAA-AAAA',
    });
    expect(wrong.status).toBe(400);
    const ok = await api.post('/v1/auth/cli-login/authorize', {
      loginToken: init.body.loginToken,
      userCode: init.body.userCode.toLowerCase(),
    });
    expect(ok.status).toBe(201);
    const poll = await agent.get(
      `/v1/auth/cli-login/poll/${init.body.loginToken}`,
    );
    expect(poll.body.status).toBe('authorized');
    expect(poll.body.agentKey).toBeTruthy();
  });

  // ─── Clusters and credentials ──────────────────────────────────────────

  let my: string;
  let myCopy: string;

  it('keeps credentials encrypted through updates and repairs plaintext rows', async () => {
    my = await createCluster({
      name: 'mysql-src',
      type: 'mysql',
      host: '127.0.0.1',
      port: 33306,
      username: 'root',
      password: 'testpass',
      database: 'synq_src',
    });
    const encrypted = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]*$/;
    const check = async () => {
      const [row] = await mysqlAdmin(
        `SELECT name, host, username, password, \`database\` FROM clusters WHERE id = '${my}'`,
        'synq_meta_test',
      );
      for (const v of Object.values(row)) expect(String(v)).toMatch(encrypted);
    };
    await check();
    expect(
      (
        await api.patch(`/v1/clusters/${my}`, {
          color: '#ffffff',
          userId: 'someone-else',
        })
      ).status,
    ).toBe(200);
    await check();

    await mysqlAdmin(
      `UPDATE clusters SET password = 'testpass' WHERE id = '${my}'`,
      'synq_meta_test',
    );
    const res = await api.get(`/v1/clusters/${my}`);
    expect(res.body.password).toBeUndefined();
    expect(res.body.host).toBeUndefined();
    await check();
    const [owner] = await mysqlAdmin(
      `SELECT userId FROM clusters WHERE id = '${my}'`,
      'synq_meta_test',
    );
    expect(owner.userId).toBe(userId);
  });

  it('rejects server-side SQLite files', async () => {
    const res = await api.post('/v1/clusters', {
      name: 'x',
      type: 'sqlite',
      host: '/etc/passwd',
    });
    expect(res.status).toBe(400);
  });

  // ─── Reading and writing typed values ──────────────────────────────────

  it('returns exact values for JSON, dates, BIGINT, DECIMAL, binary and booleans', async () => {
    const cols = await api.get(`/v1/clusters/${my}/tables/items/columns`);
    const byName = Object.fromEntries(cols.body.map((c: any) => [c.name, c]));
    expect(byName.id).toMatchObject({
      columnKey: 'PRI',
      isAutoIncrement: true,
    });
    expect(byName.meta.kind).toBe('json');
    expect(byName.active.kind).toBe('boolean');
    expect(byName.raw.kind).toBe('binary');

    const [alpha, beta] = await rowsOf(my, 'items');
    expect(alpha).toMatchObject({
      meta: { a: 1, b: 'x;y' },
      tags: [1, 2, 3],
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
      big: '9007199254740993',
      price: '12.3400',
      active: 1,
      raw: '0xdead',
    });
    expect(beta.meta).toBe('just a string');
  });

  it('updates one column without touching JSON, dates or binary', async () => {
    const res = await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
      data: { note: 'changed' },
      where: { id: 1 },
    });
    expect(res.status).toBe(200);
    const [row] = await mysqlAdmin(
      `SELECT CAST(meta AS CHAR) AS meta, born, seen_at, HEX(raw) AS raw, big FROM items WHERE id = 1`,
      'synq_src',
    );
    expect(row).toMatchObject({
      meta: '{"a": 1, "b": "x;y"}',
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
      raw: 'DEAD',
      big: '9007199254740993',
    });
  });

  it('writes JSON values and still accepts a full-row save', async () => {
    const [alpha] = await rowsOf(my, 'items');
    const res = await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
      data: {
        ...alpha,
        meta: { nested: [1, { x: null }] },
        tags: ['a'],
        active: false,
      },
      where: { id: 1 },
    });
    expect(res.status).toBe(200);
    const [row] = await mysqlAdmin(
      `SELECT CAST(meta AS CHAR) AS meta, CAST(tags AS CHAR) AS tags, active, born, HEX(raw) AS raw, big FROM items WHERE id = 1`,
      'synq_src',
    );
    expect(row).toMatchObject({
      meta: '{"nested": [1, {"x": null}]}',
      tags: '["a"]',
      active: 0,
      born: '2026-11-02',
      raw: 'DEAD',
      big: '9007199254740993',
    });
  });

  it('sets NULL properly and rejects junk instead of writing the text "null"', async () => {
    expect(
      (
        await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
          data: { price: null },
          where: { id: 3 },
        })
      ).status,
    ).toBe(200);
    const bad = await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
      data: { price: 'null' },
      where: { id: 3 },
    });
    expect(bad.status).toBe(400);
    const [row] = await mysqlAdmin(
      `SELECT price FROM items WHERE id = 3`,
      'synq_src',
    );
    expect(row.price).toBeNull();
  });

  it('touches exactly one row in tables without a primary key', async () => {
    const res = await api.del(`/v1/clusters/${my}/tables/logs_nopk/rows`, {
      where: { msg: 'dup', n: 1 },
    });
    expect(res.body.affectedRows).toBe(1);
    const upd = await api.patch(`/v1/clusters/${my}/tables/logs_nopk/rows`, {
      data: { msg: 'was-null' },
      where: { msg: 'other', n: null },
    });
    expect(upd.body.affectedRows).toBe(1);
    const rows = await mysqlAdmin(
      `SELECT msg, n FROM logs_nopk ORDER BY msg`,
      'synq_src',
    );
    expect(rows).toEqual([
      { msg: 'dup', n: 1 },
      { msg: 'was-null', n: null },
    ]);
  });

  it('returns the inserted row and deletes several rows in one request', async () => {
    const ins = await api.post(`/v1/clusters/${my}/tables/items`, {
      name: 'delta',
      meta: { k: 'v' },
      raw: '0x0102',
      born: '2026-01-15',
    });
    expect(ins.status).toBe(201);
    expect(ins.body).toMatchObject({
      name: 'delta',
      meta: { k: 'v' },
      raw: '0x0102',
      born: '2026-01-15',
      active: 1,
    });
    const ins2 = await api.post(`/v1/clusters/${my}/tables/items`, {
      name: 'epsilon',
    });
    const del = await api.del(`/v1/clusters/${my}/tables/items/rows`, {
      wheres: [{ id: ins.body.id }, { id: ins2.body.id }],
    });
    expect(del.body.affectedRows).toBe(2);
  });

  // ─── Query editor ──────────────────────────────────────────────────────

  it('pages joins with duplicate column names and ORDER BY unchanged', async () => {
    const res = await api.post(`/v1/clusters/${my}/query`, {
      query:
        'SELECT a.id, b.id, a.name FROM items a JOIN items b ON a.id = b.id ORDER BY a.id DESC;',
      page: 1,
      limit: 2,
    });
    expect(res.status).toBe(201);
    expect(res.body.totals).toEqual([3]);
    expect(res.body.results[0]).toHaveLength(2);
    expect(res.body.results[0][0].name).toBe('gamma');
  });

  it('enforces the destructive action lock on the server', async () => {
    const blocked = await api.post(`/v1/clusters/${my}/query`, {
      query: 'drop\ntable logs_nopk',
    });
    expect(blocked.status).toBe(403);
    const allowed = await api.post(`/v1/clusters/${my}/query`, {
      query: "SELECT 'drop table x' AS t",
    });
    expect(allowed.status).toBe(201);
    expect((await api.del(`/v1/clusters/${my}/tables/logs_nopk`)).status).toBe(
      403,
    );
  });

  // ─── Backup and restore ────────────────────────────────────────────────

  it('round-trips a MySQL SQL backup into an empty database', async () => {
    const backup = await api.get(`/v1/clusters/${my}/backup?format=sql`);
    expect(backup.status).toBe(200);
    expect(backup.body.content).toContain('CREATE TABLE IF NOT EXISTS `items`');
    myCopy = await createCluster({
      name: 'mysql-copy',
      type: 'mysql',
      host: '127.0.0.1',
      port: 33306,
      username: 'root',
      password: 'testpass',
      database: 'synq_copy',
    });
    const restore = await api.post(`/v1/clusters/${myCopy}/restore`, {
      format: 'sql',
      data: { content: backup.body.content },
    });
    expect(restore.status).toBe(201);
    expect(await rowsOf(myCopy, 'items')).toEqual(await rowsOf(my, 'items'));
    expect(await rowsOf(myCopy, 'kids')).toEqual([{ id: 1, item_id: 1 }]);
  });

  it('round-trips JSON and CSV backups', async () => {
    for (const format of ['json', 'csv'] as const) {
      const backup = await api.get(
        `/v1/clusters/${my}/backup?format=${format}`,
      );
      expect(backup.status).toBe(200);
      await mysqlAdmin(
        'SET FOREIGN_KEY_CHECKS=0; DELETE FROM kids; DELETE FROM items; DELETE FROM logs_nopk; SET FOREIGN_KEY_CHECKS=1;',
        'synq_copy',
      );
      const data = {
        items: backup.body.items,
        logs_nopk: backup.body.logs_nopk,
        kids: backup.body.kids,
      };
      const restore = await api.post(`/v1/clusters/${myCopy}/restore`, {
        format,
        data,
      });
      expect(restore.status).toBe(201);
      expect(await rowsOf(myCopy, 'items')).toEqual(await rowsOf(my, 'items'));
    }
  });

  // ─── Postgres ──────────────────────────────────────────────────────────

  let pg: string;

  it('reads Postgres values exactly and round-trips a SQL backup', async () => {
    pg = await createCluster({
      name: 'pg-src',
      type: 'postgres',
      host: '127.0.0.1',
      port: 35432,
      username: 'postgres',
      password: 'testpass',
      database: 'synq_pg_src',
      sslMode: 'prefer',
    });
    const [alpha] = await rowsOf(pg, 'items');
    expect(alpha).toMatchObject({
      meta: { a: [1, 2] },
      tags: ['x', 'y,z'],
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
      big: '9007199254740993',
      price: '12.3400',
      active: true,
      raw: '0xdead',
      feeling: 'happy',
    });

    // Editing a row used to fail for JSON arrays and shift dates.
    const upd = await api.patch(`/v1/clusters/${pg}/tables/items/rows`, {
      data: { meta: [1, 'two'], note: 'x' },
      where: { id: 1 },
    });
    expect(upd.status).toBe(200);
    const [after] = await rowsOf(pg, 'items');
    expect(after).toMatchObject({
      meta: [1, 'two'],
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
    });

    const backup = await api.get(`/v1/clusters/${pg}/backup?format=sql`);
    expect(backup.body.content).toContain('CREATE TYPE "public"."mood"');
    const copy = await createCluster({
      name: 'pg-copy',
      type: 'postgres',
      host: '127.0.0.1',
      port: 35432,
      username: 'postgres',
      password: 'testpass',
      database: 'synq_pg_copy',
    });
    const restore = await api.post(`/v1/clusters/${copy}/restore`, {
      format: 'sql',
      data: { content: backup.body.content },
    });
    expect(restore.status).toBe(201);
    expect(await rowsOf(copy, 'items')).toEqual(await rowsOf(pg, 'items'));
    // The identity sequence continues after the copied ids.
    const ins = await api.post(`/v1/clusters/${copy}/tables/items`, {
      name: 'next',
    });
    expect(ins.status).toBe(201);
    expect(ins.body.id).toBe(3);
  });

  it('syncs MySQL to Postgres without dropping anything', async () => {
    const target = await createCluster({
      name: 'pg-sync',
      type: 'postgres',
      host: '127.0.0.1',
      port: 35432,
      username: 'postgres',
      password: 'testpass',
      database: 'synq_pg_sync',
      environment: 'production',
    });
    const unconfirmed = await api.post(`/v1/clusters/${my}/sync/${target}`, {
      tableNames: ['items'],
      withData: true,
    });
    expect(unconfirmed.status).toBe(400);
    const res = await api.post(`/v1/clusters/${my}/sync/${target}`, {
      tableNames: ['items'],
      withData: true,
      confirmProduction: true,
    });
    expect(res.status).toBe(201);
    expect(res.body[0]).toMatchObject({
      success: true,
      created: true,
      rowsCopied: 3,
    });
    const [alpha] = await rowsOf(target, 'items');
    expect(alpha).toMatchObject({
      meta: { nested: [1, { x: null }] },
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
      big: '9007199254740993',
      active: false,
      raw: '0xdead',
    });

    // Second sync: new source column is added, existing rows are kept.
    await mysqlAdmin(
      'ALTER TABLE items ADD COLUMN extra VARCHAR(20) NULL',
      'synq_src',
    );
    await pgAdmin(
      `UPDATE items SET name = 'kept' WHERE id = 1`,
      'synq_pg_sync',
    );
    const again = await api.post(`/v1/clusters/${my}/sync/${target}`, {
      tableNames: ['items'],
      withData: true,
      confirmProduction: true,
    });
    expect(again.body[0]).toMatchObject({
      success: true,
      created: false,
      addedColumns: ['extra'],
    });
    const [kept] = await rowsOf(target, 'items');
    expect(kept.name).toBe('kept');
  });

  // ─── SQL Server ────────────────────────────────────────────────────────

  (withMssql ? it : it.skip)(
    'handles SQL Server decimals, binary NULLs, paging and backups',
    async () => {
      const ms = await createCluster({
        name: 'mssql',
        type: 'mssql',
        host: '127.0.0.1',
        port: 31433,
        username: 'sa',
        password: 'Test_pass123',
        database: 'synqtest',
      });
      const [alpha] = await rowsOf(ms, 'items');
      expect(alpha).toMatchObject({
        born: '2026-11-02',
        seen_at: '2026-11-02 08:30:00.123',
        big: '9007199254740993',
        price: '12345678901234.123456',
        cash: '12.3456',
        active: true,
        raw: '0xdead',
      });

      // The query editor gets exact decimals too (tedious would return doubles).
      const exact = await api.post(`/v1/clusters/${ms}/query`, {
        query:
          'SELECT price, cash, CAST(12345678901234567.89 AS DECIMAL(38,2)) AS big FROM items WHERE id = 1',
      });
      expect(exact.body.results[0][0]).toEqual({
        price: '12345678901234.123456',
        cash: '12.3456',
        big: '12345678901234567.89',
      });

      const upd = await api.patch(`/v1/clusters/${ms}/tables/items/rows`, {
        data: { raw: null, note: 'n' },
        where: { id: 2 },
      });
      expect(upd.status).toBe(200);

      const page = await api.post(`/v1/clusters/${ms}/query`, {
        query: 'SELECT id, name FROM items ORDER BY id DESC',
        page: 1,
        limit: 1,
      });
      expect(page.status).toBe(201);
      expect(page.body.totals).toEqual([2]);
      expect(page.body.results[0]).toEqual([{ id: 2, name: 'beta' }]);

      const backup = await api.get(`/v1/clusters/${ms}/backup?format=sql`);
      const copy = await createCluster({
        name: 'mssql-copy',
        type: 'mssql',
        host: '127.0.0.1',
        port: 31433,
        username: 'sa',
        password: 'Test_pass123',
        database: 'synqcopy',
      });
      const restore = await api.post(`/v1/clusters/${copy}/restore`, {
        format: 'sql',
        data: { content: backup.body.content },
      });
      expect(restore.status).toBe(201);
      expect(await rowsOf(copy, 'items')).toEqual(await rowsOf(ms, 'items'));
    },
  );

  // ─── Cleanup paths ─────────────────────────────────────────────────────

  it('deletes a cluster that has query history', async () => {
    const res = await api.del(`/v1/clusters/${myCopy}`);
    expect(res.status).toBe(200);
    const [count] = await mysqlAdmin(
      `SELECT COUNT(*) AS n FROM query_logs WHERE clusterId = '${myCopy}'`,
      'synq_meta_test',
    );
    expect(Number(count.n)).toBe(0);
  });

  it('logs out by revoking the session', async () => {
    expect((await agent.post('/v1/auth/logout')).status).toBe(200);
    expect((await agent.post('/v1/auth/refresh')).status).toBe(401);
  });
});
