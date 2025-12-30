# Groom API

A comprehensive NestJS-based REST API for workspace management and user authentication. This application provides secure authentication, workspace management, team collaboration features, and admin onboarding capabilities.

## Table of Contents

- [Overview](#overview)
- [Technology Stack](#technology-stack)
- [Project Structure](#project-structure)
- [Modules](#modules)
  - [App Module](#app-module)
  - [Auth Module](#auth-module)
  - [Workspace Module](#workspace-module)
  - [Admin Onboarding Module](#admin-onboarding-module)
  - [Common Module](#common-module)
  - [Config Module](#config-module)
- [Features](#features)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [API Endpoints](#api-endpoints)
- [Database](#database)
- [Security](#security)
- [Scripts](#scripts)

## Overview

Groom API is a backend service that handles:
- User authentication and authorization (JWT-based)
- OAuth integration (Google)
- Workspace creation and management
- Team member invitations
- Password reset functionality
- Admin onboarding workflows

## Technology Stack

- **Framework**: NestJS 11.x
- **Language**: TypeScript
- **Database**: PostgreSQL (via TypeORM)
- **Authentication**: JWT (Access & Refresh Tokens), Passport.js
- **Email**: Nodemailer (SMTP)
- **Security**: Helmet, Express Rate Limiting, bcryptjs
- **Validation**: class-validator, class-transformer, Joi

## Project Structure

```
src/
├── admin-onboarding/     # Admin onboarding module
├── auth/                 # Authentication module
├── workspace/            # Workspace management module
├── common/               # Shared utilities and services
├── config/               # Configuration management
├── database/             # Database migrations
├── app.module.ts         # Root application module
└── main.ts               # Application entry point
```

## Modules

### App Module

**Location**: `src/app.module.ts`

The root module of the application that imports and configures all feature modules. It sets up:
- TypeORM database connection
- Global application configuration
- Module imports (Auth, Workspace, AdminOnboarding)

**Key Features**:
- Central module registry
- Database connection initialization
- Application-wide configuration

---

### Auth Module

**Location**: `src/auth/`

Handles all authentication and authorization functionality.

#### Components:

- **AuthController** (`auth.controller.ts`): REST API endpoints for authentication
- **AuthService** (`auth.service.ts`): Business logic for authentication operations
- **AuthRepository** (`repository/auth.repository.ts`): Data access layer for user operations
- **User Entity** (`entities/user.entity.ts`): User database model
- **Guards**: JWT and Local authentication guards
- **Strategies**: JWT and Local Passport strategies
- **DTOs**: Data transfer objects for login, register, update, password reset, etc.

#### Features:

1. **User Registration**
   - Email and password-based registration
   - Password hashing with bcrypt
   - Email uniqueness validation

2. **User Login**
   - Email/password authentication
   - JWT access token generation (15 minutes expiry)
   - Refresh token generation (7 days expiry)
   - Token storage in database

3. **Token Management**
   - Access token refresh mechanism
   - Token expiry validation
   - Secure token storage

4. **OAuth Integration**
   - Google OAuth 2.0 authentication
   - Automatic user creation for OAuth users
   - Profile picture and name synchronization
   - Support for linking existing accounts

5. **Password Management**
   - Forgot password functionality
   - Secure password reset via email
   - JWT-based reset tokens (1 hour expiry)
   - Support for OAuth-only accounts

6. **User Profile**
   - Profile update functionality
   - Role-based access control
   - User status checking

#### API Endpoints:

- `POST /v1/auth/register` - Register new user
- `POST /v1/auth/login` - User login
- `POST /v1/auth/refresh` - Refresh access token
- `GET /v1/auth/oauth/google` - Initiate Google OAuth
- `GET /v1/auth/oauth/google/callback` - Google OAuth callback
- `GET /v1/auth/status` - Check authentication status
- `PATCH /v1/auth/` - Update user profile
- `POST /v1/auth/forgot-password` - Request password reset
- `POST /v1/auth/reset-password` - Reset password with token

---

### Workspace Module

**Location**: `src/workspace/`

Manages workspace creation, settings, and team member invitations.

#### Components:

- **WorkspaceController** (`workspace.controller.ts`): REST API endpoints for workspace operations
- **WorkspaceService** (`workspace.service.ts`): Business logic for workspace management
- **WorkspaceRepository** (`repository/workspace.repository.ts`): Data access layer
- **Workspace Entity** (`entities/workspace.entity.ts`): Workspace database model
- **WorkspaceMember Entity** (`entities/workspace-member.entity.ts`): Workspace member relationship model
- **DTOs**: Data transfer objects for workspace operations

#### Features:

1. **Workspace Creation**
   - Create workspaces with unique URLs
   - Industry type classification
   - Workspace description
   - Unique key generation
   - Default settings (language, currency, timezone, theme)

2. **Workspace Settings**
   - Default language configuration
   - Default currency settings
   - Timezone configuration
   - Theme preferences (light/dark)
   - Permission management (invite teammates, manage settings, view analytics)

3. **Team Member Management**
   - Invite team members via email
   - Role-based member assignment
   - Invitation token generation
   - Email notifications for invitations
   - Invitation expiry (7 days)
   - Accept invitation workflow

4. **Workspace Permissions**
   - Control who can invite teammates
   - Control who can manage settings
   - Control who can view analytics
   - Per-workspace permission configuration

#### API Endpoints:

- `POST /v1/workspace/` - Create new workspace
- `POST /v1/workspace/invite-members/:workspaceId` - Invite team members
- `POST /v1/workspace/settings/:workspaceId` - Update workspace settings
- `POST /v1/workspace/accept-invite` - Accept workspace invitation
- `GET /v1/workspace/:workspaceId` - Get workspace details

---

### Admin Onboarding Module

**Location**: `src/admin-onboarding/`

Handles the initial setup process for new administrators, creating both user accounts and workspaces in a single operation.

#### Components:

- **AdminOnboardingController** (`admin-onboarding.controller.ts`): REST API endpoint for onboarding
- **AdminOnboardingService** (`admin-onboarding.service.ts`): Business logic for onboarding workflow
- **CreateWorkspaceDto** (`dto/create-workspace.dto.ts`): Data transfer object for onboarding

#### Features:

1. **Unified Onboarding**
   - Create admin user account
   - Create workspace for the admin
   - Link admin user to workspace
   - Set onboarding plan
   - Single API call for complete setup

2. **Validation**
   - Email uniqueness check
   - Workspace URL uniqueness check
   - Conflict detection and error handling

3. **Automatic Setup**
   - Workspace member creation
   - Automatic invitation acceptance
   - Default workspace configuration

#### API Endpoints:

- `POST /v1/admin/onboarding/` - Create admin user and workspace

---

### Common Module

**Location**: `src/common/`

Shared utilities and services used across the application.

#### Components:

1. **EmailService** (`services/email.service.ts`)
   - SMTP email configuration
   - Password reset email templates
   - Workspace invitation email templates
   - HTML and plain text email support
   - Email delivery verification

2. **Password Utilities** (`password/index.ts`)
   - Password hashing with bcrypt
   - Password validation
   - Salt generation

3. **Base Repository** (`repository/base.repository.ts`)
   - Common database operations
   - Reusable repository patterns

4. **Enums** (`enums/`)
   - Role enum (User, Admin)
   - Workspace-related enums (currency, language, theme, workspace roles)

5. **Interfaces** (`interfaces/`)
   - Shared TypeScript interfaces
   - Date query interfaces

---

### Config Module

**Location**: `src/config/`

Centralized configuration management using environment variables.

#### Components:

- **ConfigService** (`config.service.ts`): Environment variable validation and configuration
- **TypeORM Config** (`typeorm.config.ts`): Database connection configuration

#### Configuration Areas:

1. **Application**
   - Port configuration
   - Environment (development, staging, production)

2. **Database**
   - Database connection URL
   - TypeORM configuration

3. **JWT**
   - Secret keys (access and refresh)
   - Token expiration times
   - Token configuration

4. **OAuth (Google)**
   - Client ID and Secret
   - Redirect URI
   - OAuth configuration

5. **Email (SMTP)**
   - SMTP host and port
   - SMTP credentials
   - Email sender configuration

6. **Frontend**
   - Frontend URL for redirects
   - CORS configuration

#### Validation:

- Uses Joi for environment variable validation
- Ensures all required variables are present
- Provides default values where appropriate
- Throws errors for missing required configuration

---

## Features

### Security Features

- **JWT Authentication**: Secure token-based authentication
- **Password Hashing**: bcrypt with salt rounds
- **Rate Limiting**: 100 requests per 15 minutes per IP
- **Helmet**: Security headers for HTTP responses
- **CORS**: Configurable cross-origin resource sharing
- **Input Validation**: class-validator for request validation
- **SQL Injection Protection**: TypeORM parameterized queries

### Authentication Features

- Email/password authentication
- Google OAuth 2.0 integration
- Refresh token mechanism
- Password reset via email
- Role-based access control
- Token expiry management

### Workspace Features

- Multi-tenant workspace support
- Unique workspace URLs
- Team member invitations
- Workspace settings management
- Permission-based access control
- Industry type classification

## Getting Started

### Prerequisites

- Node.js (v18 or higher)
- PostgreSQL database
- npm or yarn package manager

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd groom-api
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables (see [Environment Variables](#environment-variables))

4. Run database migrations:
```bash
npm run migration:run
```

5. Start the development server:
```bash
npm run start:dev
```

The API will be available at `http://localhost:${PORT}` (default port from environment variables).

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Application
PORT=3000
ENVIRONMENT=development

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/groom_db

# JWT
JWTSECRET=your-secret-key-here
JWT_REFRESH_SECRET=your-refresh-secret-key-here
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d

# Google OAuth
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_REDIRECT_URI=http://localhost:3000/v1/auth/oauth/google/callback

# Frontend
FRONTEND_URL=http://localhost:3000

# SMTP (Email)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=your-email@gmail.com
```

## API Endpoints

### Authentication Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/v1/auth/register` | Register new user | No |
| POST | `/v1/auth/login` | User login | No |
| POST | `/v1/auth/refresh` | Refresh access token | No |
| GET | `/v1/auth/oauth/google` | Initiate Google OAuth | No |
| GET | `/v1/auth/oauth/google/callback` | Google OAuth callback | No |
| GET | `/v1/auth/status` | Check auth status | Yes |
| PATCH | `/v1/auth/` | Update user profile | Yes |
| POST | `/v1/auth/forgot-password` | Request password reset | No |
| POST | `/v1/auth/reset-password` | Reset password | No |

### Workspace Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/v1/workspace/` | Create workspace | Yes |
| POST | `/v1/workspace/invite-members/:workspaceId` | Invite members | Yes |
| POST | `/v1/workspace/settings/:workspaceId` | Update settings | Yes |
| POST | `/v1/workspace/accept-invite` | Accept invitation | No |
| GET | `/v1/workspace/:workspaceId` | Get workspace | Yes |

### Admin Onboarding Endpoints

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/v1/admin/onboarding/` | Create admin and workspace | No |

## Database

### Entities

1. **User** (`auth_users` table)
   - User authentication and profile information
   - OAuth provider details
   - Token storage

2. **Workspace** (`workspaces` table)
   - Workspace configuration
   - Settings and preferences
   - Permission flags

3. **WorkspaceMember** (`workspace_members` table)
   - User-workspace relationships
   - Invitation management
   - Member roles

### Migrations

Database migrations are located in `src/database/migrations/`. Use the following commands:

```bash
# Generate migration
npm run migration:generate

# Run migrations
npm run migration:run

# Revert last migration
npm run migration:revert
```

## Security

### Implemented Security Measures

1. **Helmet**: Sets various HTTP headers for security
2. **Rate Limiting**: Prevents brute force attacks
3. **Password Hashing**: bcrypt with salt rounds
4. **JWT Tokens**: Secure token-based authentication
5. **Input Validation**: Prevents injection attacks
6. **CORS**: Controlled cross-origin access
7. **SQL Injection Protection**: TypeORM parameterized queries

### Best Practices

- Never commit `.env` files
- Use strong JWT secrets
- Regularly rotate secrets in production
- Use HTTPS in production
- Implement proper error handling
- Validate all user inputs
- Use rate limiting for authentication endpoints

## Scripts

| Script | Description |
|--------|-------------|
| `npm run build` | Build the application |
| `npm run start` | Start the application |
| `npm run start:dev` | Start in development mode with watch |
| `npm run start:debug` | Start in debug mode |
| `npm run start:prod` | Start in production mode |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run unit tests |
| `npm run test:e2e` | Run end-to-end tests |
| `npm run migration:generate` | Generate new migration |
| `npm run migration:run` | Run pending migrations |
| `npm run migration:revert` | Revert last migration |

## License

UNLICENSED - Private project

## Author

[Your Name/Organization]

---

For more information or support, please contact the development team.
