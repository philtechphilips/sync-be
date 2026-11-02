/**
 * Two API instances sharing Redis, with the agent connected to only one.
 * SYNQ_E2E=1 npm run test:e2e (needs the Redis container from test/README.md)
 */
process.env.REDIS_URL = 'redis://127.0.0.1:36379';

import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ChildProcess, execFileSync, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AddressInfo } from 'net';
import Redis from 'ioredis';
import * as mysql from 'mysql2/promise';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';

const run = process.env.SYNQ_E2E === '1' ? describe : describe.skip;
const AGENT = join(__dirname, '../../synqdb-agent/index.js');

async function startApp() {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  return app;
}

run('multiple API instances (e2e)', () => {
  let a: NestExpressApplication;
  let b: NestExpressApplication;
  let agent: ChildProcess | undefined;
  let agentExited = false;
  let agentLog = '';
  let token = '';
  const home = mkdtempSync(join(tmpdir(), 'synq-multi-'));
  const onB = {
    get: (url: string) =>
      request(b.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${token}`),
    post: (url: string, body?: object) =>
      request(b.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  };

  beforeAll(async () => {
    await new Redis(process.env.REDIS_URL!).flushall();
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 33306,
      user: 'root',
      password: 'testpass',
      multipleStatements: true,
    });
    await conn.query(`DROP DATABASE IF EXISTS synq_meta_test; CREATE DATABASE synq_meta_test;
      DROP DATABASE IF EXISTS synq_multi; CREATE DATABASE synq_multi; USE synq_multi;
      CREATE TABLE t (id INT AUTO_INCREMENT PRIMARY KEY, v VARCHAR(20));
      INSERT INTO t (v) VALUES ('one'), ('two');
      DROP DATABASE IF EXISTS synq_multi_copy; CREATE DATABASE synq_multi_copy;`);
    await conn.end();

    a = await startApp(); // runs the migrations
    b = await startApp();

    await request(b.getHttpServer())
      .post('/v1/auth/register')
      .send({ email: 'm@example.com', password: 'correct horse' });
    token = (
      await request(b.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'm@example.com', password: 'correct horse' })
    ).body.access_token;
    const { agentKey } = (await onB.get('/v1/auth/agent-key')).body;

    const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home };
    execFileSync(
      process.execPath,
      [
        AGENT,
        'add',
        'multi',
        'mysql://root:testpass@127.0.0.1:33306/synq_multi',
      ],
      { env },
    );
    execFileSync(
      process.execPath,
      [
        AGENT,
        'add',
        'multi-copy',
        'mysql://root:testpass@127.0.0.1:33306/synq_multi_copy',
      ],
      { env },
    );
    // The agent connects to instance A only.
    agent = spawn(process.execPath, [AGENT], {
      env: {
        ...env,
        SYNQDB_SERVER_URL: `http://127.0.0.1:${(a.getHttpServer().address() as AddressInfo).port}`,
        SYNQDB_AGENT_KEY: agentKey,
      },
    });
    agent.stdout?.on('data', (d) => (agentLog += String(d)));
    agent.stderr?.on('data', (d) => (agentLog += String(d)));
    agent.on('exit', () => (agentExited = true));
    for (let i = 0; i < 50; i++) {
      if ((await onB.get('/v1/auth/agent-status')).body.connected) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`Agent did not register:\n${agentLog}`);
  });

  afterAll(async () => {
    agent?.kill('SIGINT');
    await a?.close();
    await b?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('serves agent status and queries from the instance without the socket', async () => {
    const status = (await onB.get('/v1/auth/agent-status')).body;
    expect(status).toMatchObject({ connected: true, version: '1.2.0' });
    expect(status.connections.map((c: any) => c.name)).toEqual([
      'multi',
      'multi-copy',
    ]);

    const id = (
      await onB.post('/v1/clusters', {
        name: 'multi',
        type: 'mysql',
        isLocal: true,
        agentConnection: 'multi',
      })
    ).body.id;
    const rows = (await onB.get(`/v1/clusters/${id}/tables/t`)).body.data;
    expect(rows).toEqual([
      { id: 1, v: 'one' },
      { id: 2, v: 'two' },
    ]);
    const ins = await onB.post(`/v1/clusters/${id}/tables/t`, { v: 'three' });
    expect(ins.body).toEqual({ id: 3, v: 'three' });

    // A backup + restore runs an agent transaction across instances.
    const backup = await onB.get(`/v1/clusters/${id}/backup?format=sql`);
    const copy = (
      await onB.post('/v1/clusters', {
        name: 'copy',
        type: 'mysql',
        isLocal: true,
        agentConnection: 'multi-copy',
      })
    ).body.id;
    expect(
      (
        await onB.post(`/v1/clusters/${copy}/restore`, {
          format: 'sql',
          data: { content: backup.body.content },
        })
      ).status,
    ).toBe(201);
    expect(
      (await onB.get(`/v1/clusters/${copy}/tables/t`)).body.data,
    ).toHaveLength(3);
  });

  it('keeps CLI logins in the database so any instance can finish them', async () => {
    const init = (
      await request(a.getHttpServer())
        .post('/v1/auth/cli-login/init')
        .send({ hostname: 'box' })
    ).body;
    expect(
      (await onB.get(`/v1/auth/cli-login/info/${init.loginToken}`)).body
        .hostname,
    ).toBe('box');
    expect(
      (
        await onB.post('/v1/auth/cli-login/authorize', {
          loginToken: init.loginToken,
          userCode: init.userCode,
        })
      ).status,
    ).toBe(201);
    const poll = await request(a.getHttpServer()).get(
      `/v1/auth/cli-login/poll/${init.loginToken}`,
    );
    expect(poll.body.status).toBe('authorized');
  });

  it('kicks an agent on another instance when the key is rotated', async () => {
    expect((await onB.post('/v1/auth/rotate-agent-key')).status).toBe(201);
    for (let i = 0; i < 30 && !agentExited; i++)
      await new Promise((r) => setTimeout(r, 200));
    expect(agentExited).toBe(true);
    expect(agentLog).toContain('rotated');
    expect((await onB.get('/v1/auth/agent-status')).body.connected).toBe(false);
  });

  it('shares rate limits between instances', async () => {
    const attempt = (app: NestExpressApplication) =>
      request(app.getHttpServer())
        .post('/v1/auth/login')
        .send({ email: 'm@example.com', password: 'wrong pass' });
    const statuses: number[] = [];
    for (let i = 0; i < 24; i++)
      statuses.push((await attempt(i % 2 ? a : b)).status);
    // 20 attempts per 15 minutes in total, not 20 per instance (1 was used to sign in).
    expect(statuses.filter((s) => s === 429).length).toBe(5);
  });
});
