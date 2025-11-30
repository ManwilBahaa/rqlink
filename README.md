# Rqlink

Rqlink is a lightweight, intuitive, **Prisma-style ORM** client for [rqlite](https://github.com/rqlite/rqlite). It provides a type-safe(ish) JavaScript API to interact with your distributed SQLite database, handling connections, query building, and **safe schema migrations** automatically.

## Features

- 🚀 **Prisma-like API**: `findMany`, `findUnique`, `create`, `update`, `delete`.
- 🛡️ **Safe Migrations**: `initDB()` automatically creates tables and adds missing columns without data loss.
- 🔍 **Powerful Filtering**: Support for `gt`, `lt`, `contains`, `startsWith`, `in`, `OR`, `NOT`, and more.
- ⚡ **Multi-Port Support**: Easily manage sharded databases across different rqlite ports.
- 📦 **Zero Dependencies**: Built on native `fetch`.

---

## Installation

```bash
npm install rqlink
# or
bun add rqlink
```

---

## Quick Start

### 1. Define your Schema

Create a `schema.js` file to define your database structure. Rqlink uses a simple JavaScript object for schema definition.

```javascript
// schema.js
export const schema = {
  // Table Name
  users: {
    port: 4001, // rqlite port for this table
    primaryKey: "id",
    fields: {
      // Column definitions
      id: { type: "INTEGER", pk: true, autoIncrement: true },
      email: { type: "TEXT", notNull: true },
      name: { type: "TEXT" },
      age: { type: "INTEGER" },
      is_active: { type: "INTEGER", default: 1 }, // SQLite uses 0/1 for booleans
      created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" }
    },
    indexes: [
      { name: "uq_users_email", columns: ["email"], unique: true },
      { columns: ["name"] } // Simple index
    ]
  },
  posts: {
    port: 4001,
    primaryKey: "id",
    fields: {
      id: { type: "TEXT", pk: true },
      user_id: { type: "INTEGER" },
      title: { type: "TEXT" },
      content: { type: "TEXT" }
    }
  }
};
```

### 2. Initialize the Database

Before using the client, run `initDB()`. This function is **safe to run repeatedly**.

> **🛡️ Safety Note:** `initDB` checks your schema against the actual database. If you add new fields to your `schema.js`, `initDB` will automatically `ALTER TABLE` to add them. **It will NEVER delete columns or drop tables**, ensuring your data is safe.

```javascript
import { initDB } from "rqlink";

async function main() {
  await initDB({ verbose: true }); // verbose logs SQL commands
  console.log("Database initialized and up-to-date!");
}

main();
```

### 3. Use the Client

Import `db` to start querying.

```javascript
import { db } from "rqlink";

// Create a user
const user = await db.users.create({
  data: {
    name: "Alice",
    email: "alice@example.com",
    age: 25
  }
});
// Returns: { id: 1, name: "Alice", email: "alice@example.com", age: 25, is_active: 1, created_at: "..." }

// Find users
const users = await db.users.findMany({
  where: {
    age: { gt: 20 },
    name: { startsWith: "A" }
  },
  orderBy: { age: "desc" }
});
// Returns: [ { id: 1, name: "Alice", ... }, ... ]
```

---

## Schema Definition Guide

The schema is the heart of Rqlink. Here is a breakdown of the field options.

### Field Types & Variants

SQLite has a dynamic type system, but Rqlink enforces structure.

| Type | Description | JavaScript Equivalent |
| :--- | :--- | :--- |
| `INTEGER` | Whole numbers. Used for IDs, counts, booleans (0/1). | `number` |
| `TEXT` | Strings. Used for names, UUIDs, JSON strings, dates. | `string` |
| `REAL` | Floating point numbers. | `number` |
| `BLOB` | Binary data. | `Buffer` / `Uint8Array` |
| `NUMERIC` | Flexible number type. | `number` |

### Field Options

```javascript
fields: {
  // Primary Key (Auto Incrementing)
  id: { type: "INTEGER", pk: true, autoIncrement: true },

  // Required Field
  username: { type: "TEXT", notNull: true },

  // Default Value (SQL syntax)
  role: { type: "TEXT", default: "'user'" },
  created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" },
  
  // Boolean (Convention: 0 = false, 1 = true)
  is_verified: { type: "INTEGER", default: 0 } 
}
```

---

## API Reference

### `findMany({ where, select, orderBy, limit, offset })`

Retrieve multiple records with powerful filtering.

```javascript
const results = await db.users.findMany({
  where: {
    // Exact match
    role: "admin",
    
    // Logical Operators
    OR: [
      { age: { gt: 30 } },
      { age: { lt: 20 } }
    ],
    
    // Field Operators
    name: { contains: "John" }, // LIKE %John%
    status: { in: ["active", "pending"] },
    score: { gte: 50, lte: 100 }
  },
  select: { id: true, name: true }, // Only fetch these columns
  orderBy: { created_at: "desc" },
  limit: 10,
  offset: 0
});
// Returns: [ { id: 5, name: "John Doe" }, { id: 8, name: "Johnny" } ]
```

#### Supported Filters
- `equals`: Exact match (implicit if value is not an object).
- `not`: Not equal.
- `gt`, `gte`: Greater than (or equal).
- `lt`, `lte`: Less than (or equal).
- `contains`: Substring match (`LIKE %val%`).
- `startsWith`: Prefix match (`LIKE val%`).
- `endsWith`: Suffix match (`LIKE %val`).
- `in`: Match any value in an array.

### `findUnique({ where, select })`

Retrieve a single record. Best used with unique fields like IDs or emails.

```javascript
const user = await db.users.findUnique({
  where: { email: "alice@example.com" }
});
// Returns: { id: 1, name: "Alice", ... } or null
```

### `findFirst({ where, select, orderBy })`

Retrieve the first record matching the criteria.

```javascript
const latestPost = await db.posts.findFirst({
  where: { user_id: 1 },
  orderBy: { created_at: "desc" }
});
// Returns: { id: "post_123", title: "My First Post", ... } or null
```

### `create({ data, select })`

Insert a new record. Returns the created record (including auto-generated IDs).

```javascript
const newUser = await db.users.create({
  data: {
    name: "Bob",
    email: "bob@example.com"
  }
});
// Returns: { id: 2, name: "Bob", email: "bob@example.com", ... }
```

### `update({ where, data, select })`

Update records matching the `where` clause.

```javascript
const updated = await db.users.update({
  where: { id: 1 },
  data: {
    name: "Robert",
    is_active: 1
  }
});
// Returns: { id: 1, name: "Robert", is_active: 1, ... } (Updated Record)
```

### `delete({ where })`

Delete records.

```javascript
await db.users.delete({
  where: { id: 1 }
});
// Returns: true
```

### `count({ where })`

Count records matching the criteria.

```javascript
const count = await db.users.count({
  where: { is_active: 1 }
});
// Returns: 42 (number)
```

---

## Configuration

You can configure the client globally.

```javascript
import { configure } from "rqlink";

configure({
  baseUrl: "http://192.168.1.50", // rqlite node address
  timeout: 5000, // Request timeout in ms
  verbose: true // Log all SQL queries to console
});
```

---

## Author

Created and maintained by: **Manwil Bahaa Zaki**
- Email: [manwilbahaa@gmail.com](mailto:manwilbahaa@gmail.com)
- LinkedIn: [linkedin.com/in/manwil](https://linkedin.com/in/manwil)

## Disclaimer

**LIMITATION OF LIABILITY**: I, as the developer, am not responsible for any security vulnerabilities, data loss, or damages arising from the use of this software. This package is maintained to the best of my knowledge and is open for improvement. Use at your own risk.
