# Rqlink

A lightweight, Prisma-style ORM for [rqlite](https://github.com/rqlite/rqlite), designed for distributed Node.js applications.

![Rqlink Logo](./Rqlink%20logo.png)

## Features

- **Prisma-like API**: Familiar `create`, `findMany`, `findUnique`, `update`, `delete` syntax
- **Safe Migrations**: `initDB()` automatically creates tables and adds missing columns without data loss
- **Distributed & Resilient**: Supports multiple rqlite nodes with automatic failover and load balancing
- **Multi-Database Support**: Manage tables across different rqlite clusters (ports) in a single schema
- **Type Safety**: Validates schema definitions and ensures correct data types
- **Batch Operations**: Support for atomic batch inserts/updates
- **SQL Injection Protection**: Parameterized queries and strict math expression validation
- **Schema Cache**: TTL-based caching for improved performance

## Installation

```bash
npm install rqlink
```

## Quick Start

### 1. Define your Schema

```javascript
// schema.js
export const schema = {
  users: {
    config: {
      port: 4001,
      base: ["http://localhost", "http://192.168.1.5"], // List of rqlite nodes
      username: "admin", // Optional Basic Auth
      password: "secret_password"
    },
    fields: {
      id: { type: "INTEGER", pk: true, autoIncrement: true },
      email: { type: "TEXT" },
      name: { type: "TEXT" },
      created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" }
    },
    indexes: [
      { columns: ["email"], unique: true }
    ]
  }
};
```

### 2. Initialize Client

```javascript
import { createClient } from 'rqlink';
import { schema } from './schema.js';

const { db, initDB, dropDB } = createClient(schema);

// Initialize tables (create/migrate)
await initDB({ verbose: true });
```

### 3. CRUD Operations

```javascript
// Create
const user = await db.users.create({
  data: { email: "alice@example.com", name: "Alice" }
});

// Find Many
const users = await db.users.findMany({
  where: { name: { contains: "Ali" } },
  orderBy: { id: "desc" },
  limit: 10
});

// Update with math expression
const updated = await db.users.update({
  where: { id: user.id },
  data: { 
    balance: { math: '"balance" * 2 + :bonus', args: { bonus: 50 } }
  }
});

// Delete
await db.users.delete({ where: { id: user.id } });
```

### 4. Batch Operations

```javascript
const batch = db.batch.start();

batch.users.create({ data: { name: "Bob", email: "bob@test.com" } });
batch.users.update({ 
  where: { name: "Alice" }, 
  data: { balance: { increment: 100 } } 
});

const results = await batch.execute();
```

## Configuration

```javascript
import { configure } from 'rqlink';

configure({
  timeout: 5000,         // Request timeout in ms (default: 5000)
  verbose: true,         // Log SQL queries in development
  freshness: "0.1s",     // Freshness for read consistency
  freshness_strict: true,// Strict freshness checking
  retryDelay: 50,        // Base delay between retries in ms
  maxRequestSize: 1024 * 1024, // Max request payload (1MB)
  requireTLS: false      // Require HTTPS (set true for PHI/EMR)
});
```

## Security Features

Rqlink includes multiple layers of protection against SQL injection and other attacks:

### Parameterized Queries
All user values are passed as named parameters, never interpolated into SQL strings.

### Math Expression Validation
The `math` update operator validates expressions against:
- Character whitelist (alphanumeric, arithmetic operators, parentheses)
- SQL keyword blocklist (DROP, SELECT, UNION, INSERT, DELETE, etc.)
- Comment pattern detection (`--`, `/*`, `*/`)

```javascript
// ✅ Safe - uses parameterized arguments
await db.users.update({
  where: { id: 1 },
  data: { balance: { math: '"balance" * :mult + :bonus', args: { mult: 2, bonus: 50 } } }
});

// ❌ Blocked - contains SQL keyword
await db.users.update({
  where: { id: 1 },
  data: { balance: { math: 'SELECT * FROM users' } } // Throws error
});
```

### Schema Validation
- Table and column names restricted to `[a-zA-Z0-9_]+`
- Column types validated against SQLite types
- Default values sanitized

### Request Size Limits
Configurable `maxRequestSize` prevents DoS via large payloads (default: 1MB).

### TLS Enforcement
Enable `requireTLS: true` for PHI/EMR environments to block non-HTTPS connections.

## Query Operators

| Operator      | Description                    | Example                              |
|---------------|--------------------------------|--------------------------------------|
| `equals`      | Exact match                    | `{ id: { equals: 1 } }`              |
| `not`         | Not equal                      | `{ status: { not: "deleted" } }`     |
| `gt`          | Greater than                   | `{ age: { gt: 18 } }`                |
| `gte`         | Greater than or equal          | `{ age: { gte: 18 } }`               |
| `lt`          | Less than                      | `{ price: { lt: 100 } }`             |
| `lte`         | Less than or equal             | `{ price: { lte: 100 } }`            |
| `contains`    | LIKE %value%                   | `{ name: { contains: "john" } }`     |
| `startsWith`  | LIKE value%                    | `{ email: { startsWith: "admin" } }` |
| `endsWith`    | LIKE %value                    | `{ email: { endsWith: ".com" } }`    |
| `in`          | IN (values)                    | `{ status: { in: ["a", "b"] } }`     |
| `OR`          | Logical OR                     | `{ OR: [{ a: 1 }, { b: 2 }] }`       |
| `NOT`         | Logical NOT                    | `{ NOT: { status: "deleted" } }`     |

## Update Operators

| Operator      | Description                    | Example                              |
|---------------|--------------------------------|--------------------------------------|
| `increment`   | Add to current value           | `{ balance: { increment: 50 } }`     |
| `math`        | Custom math expression         | `{ balance: { math: '"balance" * :x', args: { x: 2 } } }` |

## Consistency Levels

Use `level` parameter for read operations:

```javascript
// Strong consistency (reads from leader)
await db.users.findMany({ level: "strong" });

// Default: freshness-based consistency
await db.users.findMany(); // Uses configured freshness
```

## Schema Cache

Rqlink caches table schema information for 5 minutes (configurable) to reduce PRAGMA calls. The cache:
- Automatically expires after TTL
- Is invalidated on schema changes (ALTER TABLE)
- Has a size limit of 100 entries to prevent memory leaks

## License

MIT
