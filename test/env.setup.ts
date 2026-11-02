// Test configuration. SKIP_DOTENV keeps the developer's real .env (which
// may point at a production database) from ever being loaded by tests.
process.env.SKIP_DOTENV = '1';
const defaults: Record<string, string> = {
  PORT: '0',
  ENVIRONMENT: 'test',
  DB_HOST: '127.0.0.1',
  DB_PORT: '33306',
  DB_USERNAME: 'root',
  DB_PASSWORD: 'testpass',
  DB_NAME: 'synq_meta_test',
  DB_ENCRYPTION_KEY: 'a'.repeat(64),
  JWTSECRET: 'test-secret-test-secret-test-secret',
  GOOGLE_CLIENT_ID: 'test',
  GOOGLE_CLIENT_SECRET: 'test',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  FRONTEND_URL: 'http://localhost:3000',
  SMTP_USER: 'test',
  SMTP_PASS: 'test',
  ALLOW_PRIVATE_DB_HOSTS: 'true',
};
for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
