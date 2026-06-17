# Synq API 🚀

A high-performance, enterprise-grade NestJS backend for **Synq**—a multi-database management and synchronization platform. This API enables developers to manage database clusters (MySQL & PostgreSQL), execute AI-powered SQL operations, and synchronize schemas across environments with precision.

## 📑 Table of Contents

- [Overview](#-overview)
- [Core Features](#-core-features)
- [Technology Stack](#-technology-stack)
- [Architecture & Modules](#-architecture--modules)
  - [Clusters Module](#clusters-module)
  - [AI Module](#ai-module)
  - [Query Management Module](#query-management-module)
  - [Auth Module](#auth-module)
- [Project Structure](#-project-structure)
- [Getting Started](#-getting-started)
  - [Prerequisites](#prerequisites)
  - [Local Setup](#local-setup)
  - [Environment Variables](#environment-variables)
- [API Endpoints](#-api-endpoints)
- [Security & Performance](#-security--performance)
- [License](#-license)

---

## 🌟 Overview

Synq API serves as the backbone of the Synq ecosystem. It provides the heavy-lifting required for cross-database communications, schema introspection, and AI-driven intelligence. Designed for scalability and speed, it uses a modular architecture built on the **NestJS** framework.

---

## ✨ Core Features

### 🔌 Multi-Database Connectivity
*   **Engine Support**: Seamlessly connect to **PostgreSQL** and **MySQL** clusters.
*   **Data Explorer**: High-performance data retrieval with server-side pagination, sorting, and complex filtering.
*   **Real-time Introspection**: Fetch table schemas, relationship graphs, and metadata on the fly.

### 🤖 AI-Powered SQL Intelligence
*   **GPT-4o Integration**: Explain complex SQL queries in plain English.
*   **Optimization engine**: Receive actionable suggestions to improve query performance and indexing.

### 🔄 Schema Synchronization Workbench
*   **Drift Analysis**: Compare schemas between two clusters (e.g., Staging vs. Production).
*   **Automated Syncing**: Synchronize tables, columns, and relationships across different metadata stores.

### 📚 Hierarchical Query Management
*   **Persistent Library**: Save, tag, and organize SQL queries in a folder-based hierarchy.
*   **Tab Sync**: Persistent editor state that links local UI tabs to database-backed query records.

### 📦 Robust Data Export
*   **Multiple Formats**: Export table data to **CSV, JSON, SQL, PDF,** and **Markdown** using a high-performance streaming-ready architecture.

---

## 🛠 Technology Stack

*   **Framework**: NestJS (v11+)
*   **Language**: TypeScript
*   **ORM**: TypeORM (PostgreSQL for metadata storage)
*   **AI Engine**: OpenAI (GPT-4o)
*   **Authentication**: Passport.js (JWT & Google OAuth 2.0)
*   **Validation**: Class-Validator & Class-Transformer
*   **Security**: Helmet, Express Rate Limit, Bcrypt

---

## 🏗 Architecture & Modules

### Clusters Module
**Location**: `src/clusters/`
The core engine for database interaction. It handles native connections to target clusters using specialized adapters.
*   **Features**: Table CRUD operations, Schema comparison (Synq Workbench), Database backup/restore (SQL/JSON), and Query execution logs.

### AI Module
**Location**: `src/ai/`
Integrates with OpenAI to provide intelligence over raw SQL.
*   **Features**: Natural language explanations, Performance bottleneck detection, and Auto-complete suggestion support.

### Query Management Module
**Location**: `src/query-management/`
Manages the user's personal SQL library.
*   **Features**: Hierarchical collections (folders), Tag-based searching, and Tab persistence logic.

### Auth Module
**Location**: `src/auth/`
Handles identity management and access control.
*   **Features**: JWT-based session management, Refresh token rotations, Social login via Google, and browser-based CLI authentication (device-flow style — no keys copied in the terminal).

### Agent Module
**Location**: `src/agent/`
Manages the local agent relay over WebSocket.
*   **Features**: Per-user agent registration, live query routing to the connected agent, and key rotation with automatic disconnection.

---

## 📂 Project Structure

```
src/
├── ai/                   # AI Intelligence layer (GPT-4o)
├── auth/                 # Identity & Session Management
├── clusters/             # Database Connectivity & Sync Engine
├── query-management/     # Saved Queries & Collections
├── common/               # Midleware, Filters, Enriched Decorators
├── config/               # Joi-validated Environment Configuration
├── database/             # TypeORM Migrations & Entities
├── app.module.ts         # Root Application Module
└── main.ts               # Bootstrapping & Global Configuration
```

---

## 🚀 Getting Started

### Prerequisites
*   **Node.js**: v18 or higher (v20+ recommended)
*   **PNPM**: Recommended package manager
*   **PostgreSQL**: Local instance for Synq metadata storage
*   **Redis**: (Optional) For high-speed caching

### Local Setup

1. **Clone the repository**:
```bash
git clone <repository-url>
cd multidbm/api
```

2. **Install dependencies**:
```bash
pnpm install
```

3. **Configure Environment**:
Create a `.env` file based on the template below.

4. **Run Database Migrations**:
```bash
pnpm run migration:run
```

5. **Start Development Server**:
```bash
pnpm run start:dev
```

### Environment Variables

```env
# APP
PORT=3001
ENVIRONMENT=development

# DATABASE (Metadata Store)
DATABASE_URL=postgresql://user:pass@localhost:5432/synq_metadata

# AUTH
JWT_SECRET=your_super_secret_key
JWT_REFRESH_SECRET=your_refresh_secret_key
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

# AI
OPENAI_API_KEY=sk-...

# FRONTEND
FRONTEND_URL=http://localhost:3000
```

---

## 📡 API Endpoints

### Auth — `/v1/auth`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/login` | Public | Email/password login |
| `POST` | `/register` | Public | Create account |
| `POST` | `/refresh` | Public | Refresh access token |
| `POST` | `/forgot-password` | Public | Send password reset email |
| `POST` | `/reset-password` | Public | Reset password with token |
| `GET` | `/oauth/google` | Public | Initiate Google OAuth |
| `GET` | `/oauth/google/callback` | Public | Google OAuth callback |
| `GET` | `/status` | JWT | Get current user |
| `PATCH` | `/` | JWT | Update user fields |
| `PATCH` | `/profile` | JWT | Update name / avatar / settings |
| `PATCH` | `/password` | JWT | Change password |
| `GET` | `/agent-key` | JWT | Get agent key (backfills if missing) |
| `POST` | `/rotate-agent-key` | JWT | Rotate agent key, disconnect running agent |
| `GET` | `/agent-status` | JWT | Check if agent is connected |
| `POST` | `/cli-login/init` | Public | Start browser-based CLI auth — returns a short-lived `loginToken` |
| `GET` | `/cli-login/poll/:token` | Public | Poll until user approves — returns `{status, agentKey}` |
| `POST` | `/cli-login/authorize` | JWT | Called by the web app to approve a CLI login token |

### Clusters — `/v1/clusters`

Endpoints for creating/listing clusters, executing queries, exploring schemas, and managing query logs.

### AI — `/v1/ai`

Endpoints for natural language SQL generation and query explanation (rate-limited to 300 req / 15 min).

### Query Management — `/v1/queries`, `/v1/collections`

Endpoints for saving, organizing, and retrieving named SQL queries and collections.

---

## 🛡 Security & Performance

*   **Rate Limiting**: Throttling implemented on sensitive endpoints (Auth, AI).
*   **Parameterized Queries**: Built-in protection against SQL injection through TypeORM and native safe-binding.
*   **Security Headers**: Helmet configured for strict Content Security Policy (CSP).
*   **Validation Pipes**: Global pipes ensure all incoming data conforms to DTO specifications.

---

## 📜 License

UNLICENSED - Private Property of Synq.

---

**Built with ❤️ for Database Engineers.**
