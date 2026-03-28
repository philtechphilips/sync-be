#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const path = require('node:path');

// Get migration name from command line arguments
const migrationName = process.argv[2];

if (!migrationName) {
  console.error('Error: Migration name is required');
  console.error('Usage: npm run migration:generate -- <MigrationName>');
  process.exit(1);
}

// Basic validation: migration name must only contain alphanumeric characters, underscores, or hyphens
// This prevents command injection and ensures it's a valid class/file name
if (!/^[a-zA-Z0-9_-]+$/.test(migrationName)) {
  console.error('Error: Migration name must only contain alphanumeric characters, underscores, or hyphens');
  process.exit(1);
}

// Construct the full path
const migrationPath = path.join('src', 'database', 'migrations', migrationName);

// Set a safe PATH for the subprocess to prevent command shadowing attacks
const nodeBinPath = path.dirname(process.execPath);
const safePath = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
  '/usr/local/bin',
  nodeBinPath, // Required for node, npm, and npx
].join(path.delimiter);

const commonOptions = {
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: safePath,
  },
};

try {
  // Determine the correct npm and npx commands based on the platform.
  // This allows us to avoid using 'shell: true', which is a security best practice.
  const isWin = process.platform === 'win32';
  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const npxCmd = isWin ? 'npx.cmd' : 'npx';

  // 1. Build the project
  console.log('Building project...');
  const build = spawnSync(npmCmd, ['run', 'build'], commonOptions);
  if (build.status !== 0) process.exit(build.status || 1);

  // 2. Generate the migration
  console.log(`Generating migration at: ${migrationPath}`);
  const gen = spawnSync(npxCmd, [
    'typeorm',
    'migration:generate',
    '-d', 
    'dist/config/typeorm.config.js',
    migrationPath
  ], commonOptions);
  
  if (gen.status !== 0) process.exit(gen.status || 1);
  
} catch (error) {
  console.error('Unexpected error:', error);
  process.exit(1);
}


