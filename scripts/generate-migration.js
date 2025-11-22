#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

// Get migration name from command line arguments
const migrationName = process.argv[2];

if (!migrationName) {
  console.error('Error: Migration name is required');
  console.error('Usage: npm run migration:generate -- <MigrationName>');
  process.exit(1);
}

// Construct the full path
const migrationPath = path.join('src', 'database', 'migrations', migrationName);

// Run the TypeORM command
try {
  execSync(
    `npm run build && npx typeorm -d dist/config/typeorm.config.js migration:generate ${migrationPath}`,
    { stdio: 'inherit' },
  );
} catch (error) {
  process.exit(1);
}
