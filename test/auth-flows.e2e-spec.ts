/**
 * Password-reset email (through a real SMTP catcher) and Google sign-in
 * (Google's token/userinfo endpoints stubbed). SYNQ_E2E=1 npm run test:e2e
 */
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '31025';

import { Test } from '@nestjs/testing';
import { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import * as mysql from 'mysql2/promise';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { config } from '../src/config/config.service';

const run = process.env.SYNQ_E2E === '1' ? describe : describe.skip;
const MAILPIT = 'http://127.0.0.1:38025/api/v1';

async function latestEmail(to: string) {
  for (let i = 0; i < 30; i++) {
    const list = (await (await fetch(`${MAILPIT}/messages`)).json()) as {
      messages: { ID: string; To: { Address: string }[] }[];
    };
    const msg = list.messages.find((m) => m.To.some((t) => t.Address === to));
    if (msg)
      return (await (await fetch(`${MAILPIT}/message/${msg.ID}`)).json()) as {
        HTML: string;
        Text: string;
      };
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

run('auth flows (e2e)', () => {
  let app: NestExpressApplication;
  const realFetch = global.fetch;
  let googleProfile: Record<string, unknown> = {};

  beforeAll(async () => {
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 33306,
      user: 'root',
      password: 'testpass',
      multipleStatements: true,
    });
    await conn.query(
      'DROP DATABASE IF EXISTS synq_meta_test; CREATE DATABASE synq_meta_test;',
    );
    await conn.end();
    await realFetch(`${MAILPIT}/messages`, { method: 'DELETE' });

    // Stand-in for Google's OAuth endpoints; everything else goes through.
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        const code = new URLSearchParams(init?.body as URLSearchParams).get(
          'code',
        );
        return code === 'good-code'
          ? Response.json({ access_token: 'google-access-token' })
          : Response.json({ error_description: 'Bad code' }, { status: 400 });
      }
      if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
        return Response.json(googleProfile);
      }
      return realFetch(input, init);
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
    });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  const server = () => app.getHttpServer();

  it('emails a single-use reset link that ends existing sessions', async () => {
    await request(server())
      .post('/v1/auth/register')
      .send({ email: 'reset@example.com', password: 'old password' });
    const session = request.agent(server());
    expect(
      (
        await session
          .post('/v1/auth/login')
          .send({ email: 'reset@example.com', password: 'old password' })
      ).status,
    ).toBe(200);

    const unknown = await request(server())
      .post('/v1/auth/forgot-password')
      .send({ email: 'nobody@example.com' });
    const known = await request(server())
      .post('/v1/auth/forgot-password')
      .send({ email: 'reset@example.com' });
    expect(unknown.body).toEqual(known.body); // same answer either way

    const email = await latestEmail('reset@example.com');
    expect(email).not.toBeNull();
    expect(await latestEmail('nobody@example.com')).toBeNull();
    const link = /href="([^"]*reset-password\?token=[^"]+)"/.exec(
      email!.HTML,
    )?.[1];
    expect(
      link?.startsWith(`${config.FRONTEND_URL}/auth/reset-password?token=`),
    ).toBe(true);
    const token = new URL(link!.replaceAll('&amp;', '&')).searchParams.get(
      'token',
    )!;

    const reset = await request(server())
      .post('/v1/auth/reset-password')
      .send({ token, password: 'new password' });
    expect(reset.status).toBe(200);
    expect((await session.post('/v1/auth/refresh')).status).toBe(401); // old session revoked
    const reuse = await request(server())
      .post('/v1/auth/reset-password')
      .send({ token, password: 'another one' });
    expect(reuse.status).toBe(400);
    expect(reuse.body.message).toContain('already been used');

    expect(
      (
        await request(server())
          .post('/v1/auth/login')
          .send({ email: 'reset@example.com', password: 'old password' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(server())
          .post('/v1/auth/login')
          .send({ email: 'reset@example.com', password: 'new password' })
      ).status,
    ).toBe(200);
  });

  /** Runs the redirect dance and returns the final redirect location. */
  async function googleSignIn(
    browser: ReturnType<typeof request.agent>,
    code = 'good-code',
    tamperState = false,
  ) {
    const start = await browser.get('/v1/auth/oauth/google');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const callback = await browser
      .get('/v1/auth/oauth/google/callback')
      .query({ code, state: tamperState ? `${state}x` : state });
    expect(callback.status).toBe(302);
    return callback;
  }

  it('signs in with Google without putting tokens in the URL', async () => {
    googleProfile = {
      id: 'g-1',
      email: 'Person@Gmail.com',
      verified_email: true,
      name: 'Person',
    };
    const browser = request.agent(server());
    const callback = await googleSignIn(browser);
    expect(callback.headers.location).toBe(
      `${config.FRONTEND_URL}/auth/callback`,
    );
    expect(String(callback.headers['set-cookie'])).toMatch(
      /synq_rt=.+HttpOnly/i,
    );

    const refreshed = await browser.post('/v1/auth/refresh');
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.user).toMatchObject({
      email: 'person@gmail.com',
      provider: 'google',
    });
  });

  it('rejects a forged state and failed code exchanges', async () => {
    const forged = await googleSignIn(
      request.agent(server()),
      'good-code',
      true,
    );
    expect(forged.headers.location).toContain('/auth/login?error=');
    const bad = await googleSignIn(request.agent(server()), 'bad-code');
    expect(bad.headers.location).toContain('/auth/login?error=Bad%20code');
  });

  it('does not let someone pre-register a Google user and keep access', async () => {
    // An attacker registers the victim's address with a password they know...
    await request(server())
      .post('/v1/auth/register')
      .send({ email: 'victim@gmail.com', password: 'attacker pass' });
    const attacker = request.agent(server());
    expect(
      (
        await attacker
          .post('/v1/auth/login')
          .send({ email: 'victim@gmail.com', password: 'attacker pass' })
      ).status,
    ).toBe(200);

    // ...then the real owner signs in with Google.
    googleProfile = {
      id: 'g-victim',
      email: 'victim@gmail.com',
      verified_email: true,
      name: 'Victim',
    };
    await googleSignIn(request.agent(server()));

    expect(
      (
        await request(server())
          .post('/v1/auth/login')
          .send({ email: 'victim@gmail.com', password: 'attacker pass' })
      ).status,
    ).toBe(401);
    expect((await attacker.post('/v1/auth/refresh')).status).toBe(401);
  });

  it('refuses Google accounts whose email is not verified', async () => {
    googleProfile = {
      id: 'g-2',
      email: 'unverified@example.com',
      verified_email: false,
    };
    const callback = await googleSignIn(request.agent(server()));
    expect(callback.headers.location).toContain('/auth/login?error=');
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 33306,
      user: 'root',
      password: 'testpass',
      database: 'synq_meta_test',
    });
    const [rows] = (await conn.query(
      `SELECT COUNT(*) AS n FROM auth_users WHERE email = 'unverified@example.com'`,
    )) as any;
    await conn.end();
    expect(Number(rows[0].n)).toBe(0);
  });
});
