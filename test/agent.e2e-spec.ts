/**
 * Runs the real synqdb-agent process against the API and exercises local
 * clusters through it. Needs the same containers as clusters.e2e-spec.ts:
 * SYNQ_E2E=1 npm run test:e2e
 */
process.env.TZ = 'Africa/Lagos';

import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ChildProcess, spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import * as mysql from 'mysql2/promise';
import { Client as PgClient } from 'pg';
import Database from 'better-sqlite3';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const run = process.env.SYNQ_E2E === '1' ? describe : describe.skip;
const AGENT = join(__dirname, '../../synqdb-agent/index.js');
const AGENT_VERSION = (
  JSON.parse(
    readFileSync(join(__dirname, '../../synqdb-agent/package.json'), 'utf8'),
  ) as {
    version: string;
  }
).version;
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

run('synqdb-agent (e2e)', () => {
  let app: NestExpressApplication;
  let agentProcess: ChildProcess | undefined;
  let agentLog = '';
  let agentCli: (...args: string[]) => string = () => '';
  let token = '';
  const home = mkdtempSync(join(tmpdir(), 'synq-agent-'));
  const sqliteFile = join(home, 'local.db');
  const server = () => app.getHttpServer();
  const api = {
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) =>
      request(server())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (url: string, body?: object) =>
      request(server())
        .patch(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  };
  const rowsOf = async (id: string, table: string) => {
    const res = await api.get(`/v1/clusters/${id}/tables/${table}?limit=1000`);
    expect(res.status).toBe(200);
    return res.body.data as Record<string, unknown>[];
  };
  const createLocal = async (body: Record<string, unknown>) => {
    const res = await api.post('/v1/clusters', { ...body, isLocal: true });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  beforeAll(async () => {
    const admin = await mysql.createConnection({
      ...MYSQL,
      multipleStatements: true,
    });
    await admin.query(`DROP DATABASE IF EXISTS synq_meta_test; CREATE DATABASE synq_meta_test;
      DROP DATABASE IF EXISTS synq_agent_src; DROP DATABASE IF EXISTS synq_agent_copy;
      CREATE DATABASE synq_agent_src; CREATE DATABASE synq_agent_copy;`);
    await admin.query(`USE synq_agent_src;
      CREATE TABLE items (id INT AUTO_INCREMENT PRIMARY KEY, meta JSON, born DATE, seen_at DATETIME(3), big BIGINT, raw VARBINARY(8));
      INSERT INTO items (meta, born, seen_at, big, raw) VALUES ('{"a":[1,2]}', '2026-11-02', '2026-11-02 08:30:00.123', 9007199254740993, X'beef'), (NULL, NULL, NULL, NULL, NULL);`);
    await admin.end();

    const pgAdmin = new PgClient({ ...PG, database: 'testdb' });
    await pgAdmin.connect();
    await pgAdmin.query('DROP DATABASE IF EXISTS synq_agent_pg');
    await pgAdmin.query('CREATE DATABASE synq_agent_pg');
    await pgAdmin.end();
    const pg = new PgClient({ ...PG, database: 'synq_agent_pg' });
    await pg.connect();
    await pg.query(`CREATE TABLE items (id SERIAL PRIMARY KEY, born DATE, at TIMESTAMP, meta JSONB);
      INSERT INTO items (born, at, meta) VALUES ('2026-11-02', '2026-11-02 08:30:00', '[1,"two"]');`);
    await pg.end();

    const db = new Database(sqliteFile);
    db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT, flag BOOLEAN, data BLOB, n INTEGER);
      INSERT INTO notes (body, flag, data, n) VALUES ('hello', 1, X'0102', 9007199254740993);`);
    db.close();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app);
    await app.listen(0, '127.0.0.1');

    await request(server())
      .post('/v1/auth/register')
      .send({ email: 'agent@example.com', password: 'correct horse' });
    const login = await request(server())
      .post('/v1/auth/login')
      .send({ email: 'agent@example.com', password: 'correct horse' });
    token = login.body.access_token;
    const { agentKey } = (await api.get('/v1/auth/agent-key')).body;

    const { port } = server().address() as AddressInfo;
    // Connections saved on the agent: the API only ever learns their names.
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, [AGENT, ...args], {
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      }).toString();
    cli(
      'add',
      'local-my',
      'mysql://root:testpass@127.0.0.1:33306/synq_agent_src',
    );
    cli('add', 'notes-db', `sqlite://${sqliteFile}`, '--no-test');
    agentCli = cli;

    agentProcess = spawn(process.execPath, [AGENT], {
      env: {
        PATH: process.env.PATH,
        HOME: home, // never read the developer's real ~/.synqdb-agent
        USERPROFILE: home,
        TZ: 'Africa/Lagos',
        SYNQDB_SERVER_URL: `http://127.0.0.1:${port}`,
        SYNQDB_AGENT_KEY: agentKey,
      },
    });
    agentProcess.stdout?.on('data', (d) => (agentLog += String(d)));
    agentProcess.stderr?.on('data', (d) => (agentLog += String(d)));

    for (let i = 0; i < 50; i++) {
      const status = await api.get('/v1/auth/agent-status');
      if (status.body.connected) {
        expect(status.body.version).toBe(AGENT_VERSION);
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Agent did not connect:\n${agentLog}`);
  });

  afterAll(async () => {
    agentProcess?.kill('SIGINT');
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  });

  let my = '';

  it('reads exact values through the agent in a UTC+1 timezone', async () => {
    my = await createLocal({
      name: 'local-mysql',
      type: 'mysql',
      host: '127.0.0.1',
      port: 33306,
      username: 'root',
      password: 'testpass',
      database: 'synq_agent_src',
    });
    const [row] = await rowsOf(my, 'items');
    expect(row).toMatchObject({
      meta: { a: [1, 2] },
      born: '2026-11-02',
      seen_at: '2026-11-02 08:30:00.123',
      big: '9007199254740993',
      raw: '0xbeef',
    });

    const pg = await createLocal({
      name: 'local-pg',
      type: 'postgres',
      host: '127.0.0.1',
      port: 35432,
      username: 'postgres',
      password: 'testpass',
      database: 'synq_agent_pg',
    });
    const upd = await api.patch(`/v1/clusters/${pg}/tables/items/rows`, {
      data: { meta: [3] },
      where: { id: 1 },
    });
    expect(upd.status).toBe(200);
    expect((await rowsOf(pg, 'items'))[0]).toMatchObject({
      born: '2026-11-02',
      at: '2026-11-02 08:30:00',
      meta: [3],
    });
  });

  it('reports real affected-row counts and inserted rows for MySQL', async () => {
    const res = await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
      data: { big: '1' },
      where: { id: 2 },
    });
    expect(res.body.affectedRows).toBe(1);
    const missing = await api.patch(`/v1/clusters/${my}/tables/items/rows`, {
      data: { big: '1' },
      where: { id: 999 },
    });
    expect(missing.status).toBe(404);
    const ins = await api.post(`/v1/clusters/${my}/tables/items`, {
      meta: { new: true },
      born: '2026-12-25',
    });
    expect(ins.body).toMatchObject({
      id: 3,
      meta: { new: true },
      born: '2026-12-25',
    });
  });

  it('pages, runs scripts and returns results larger than 1 MB', async () => {
    const page = await api.post(`/v1/clusters/${my}/query`, {
      query: 'SELECT a.id, b.id FROM items a JOIN items b ON a.id = b.id',
      page: 2,
      limit: 1,
    });
    expect(page.body.totals).toEqual([3]);
    expect(page.body.results[0]).toHaveLength(1);

    const script = await api.post(`/v1/clusters/${my}/query`, {
      query:
        'UPDATE items SET big = 5 WHERE id = 2; SELECT big FROM items WHERE id = 2;',
    });
    expect(script.body.results).toEqual([{ affectedRows: 1 }, [{ big: '5' }]]);

    const big = await api.post(`/v1/clusters/${my}/query`, {
      query:
        "SELECT REPEAT('x', 1000000) AS a UNION ALL SELECT REPEAT('y', 1000000) UNION ALL SELECT REPEAT('z', 1000000)",
    });
    expect(big.status).toBe(201);
    expect(big.body.results[0]).toHaveLength(3);
  });

  it('restores a backup through an agent transaction', async () => {
    const backup = await api.get(`/v1/clusters/${my}/backup?format=sql`);
    const copy = await createLocal({
      name: 'local-copy',
      type: 'mysql',
      host: '127.0.0.1',
      port: 33306,
      username: 'root',
      password: 'testpass',
      database: 'synq_agent_copy',
    });
    const restore = await api.post(`/v1/clusters/${copy}/restore`, {
      format: 'sql',
      data: { content: backup.body.content },
    });
    expect(restore.status).toBe(201);
    expect(await rowsOf(copy, 'items')).toEqual(await rowsOf(my, 'items'));
  });

  it('uses new credentials immediately after they are edited', async () => {
    const bad = await api.patch(`/v1/clusters/${my}`, {
      password: 'wrong-password',
    });
    expect(bad.status).toBe(400); // tested before saving
    await api.patch(`/v1/clusters/${my}`, { password: 'testpass' });
    expect((await api.get(`/v1/clusters/${my}/tables`)).status).toBe(200);
  });

  it('opens SQLite files on the agent machine', async () => {
    const lite = await createLocal({
      name: 'local-sqlite',
      type: 'sqlite',
      host: sqliteFile,
    });
    const cols = await api.get(`/v1/clusters/${lite}/tables/notes/columns`);
    expect(cols.body.find((c: any) => c.name === 'id')).toMatchObject({
      columnKey: 'PRI',
      isAutoIncrement: true,
    });
    expect((await rowsOf(lite, 'notes'))[0]).toMatchObject({
      body: 'hello',
      flag: 1,
      data: '0x0102',
      n: '9007199254740993',
    });

    const ins = await api.post(`/v1/clusters/${lite}/tables/notes`, {
      body: 'two',
      flag: false,
      data: '0xff',
    });
    expect(ins.body).toMatchObject({
      id: 2,
      body: 'two',
      flag: 0,
      data: '0xff',
    });
    const script = await api.post(`/v1/clusters/${lite}/query`, {
      query:
        "UPDATE notes SET body = 'x;y' WHERE id = 2; SELECT body FROM notes WHERE id = 2",
    });
    expect(script.body.results).toEqual([
      { affectedRows: 1 },
      [{ body: 'x;y' }],
    ]);
    const del = await request(server())
      .delete(`/v1/clusters/${lite}/tables/notes/rows`)
      .set('Authorization', `Bearer ${token}`)
      .send({ where: { id: 2 } });
    expect(del.body.affectedRows).toBe(1);
  });

  it('uses connections saved on the agent without storing credentials', async () => {
    const status = await api.get('/v1/auth/agent-status');
    expect(status.body.connections).toEqual([
      { name: 'local-my', type: 'mysql', database: 'synq_agent_src' },
      { name: 'notes-db', type: 'sqlite', database: 'local.db' },
    ]);
    expect(JSON.stringify(status.body)).not.toContain('testpass');

    const res = await api.post('/v1/clusters', {
      name: 'saved-conn',
      type: 'mysql',
      isLocal: true,
      agentConnection: 'local-my',
    });
    expect(res.status).toBe(201);
    expect(res.body.agentConnection).toBe('local-my');
    const conn = await mysql.createConnection({
      ...MYSQL,
      database: 'synq_meta_test',
    });
    const [stored] = (await conn.query(
      `SELECT host, username, password, \`database\` FROM clusters WHERE id = '${res.body.id}'`,
    )) as any;
    await conn.end();
    expect(stored[0]).toEqual({
      host: '',
      username: '',
      password: null,
      database: '',
    });
    expect((await rowsOf(res.body.id, 'items')).length).toBeGreaterThan(0);

    const missing = await api.post('/v1/clusters', {
      name: 'nope',
      type: 'mysql',
      isLocal: true,
      agentConnection: 'not-saved',
    });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toContain('synqdb-agent add not-saved');
  });

  it('forgets stored credentials when a cluster moves to a saved connection', async () => {
    const res = await api.patch(`/v1/clusters/${my}`, {
      agentConnection: 'local-my',
    });
    expect(res.status).toBe(200);
    const conn = await mysql.createConnection({
      ...MYSQL,
      database: 'synq_meta_test',
    });
    const [rows] = (await conn.query(
      `SELECT host, password FROM clusters WHERE id = '${my}'`,
    )) as any;
    await conn.end();
    expect(rows[0]).toEqual({ host: '', password: null });
    expect((await rowsOf(my, 'items')).length).toBeGreaterThan(0);
  });

  it('shows connections added while the agent is running', async () => {
    agentCli(
      'add',
      'later-pg',
      'postgres://postgres:testpass@127.0.0.1:35432/synq_agent_pg?ssl=disable',
    );
    for (let i = 0; i < 30; i++) {
      const names = (
        await api.get('/v1/auth/agent-status')
      ).body.connections.map((c: any) => c.name);
      if (names.includes('later-pg')) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('the agent did not report the new connection');
  });
});
