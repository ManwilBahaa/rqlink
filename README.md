# Rqlink

Rqlink is a lightweight, intuitive, **[Prisma](https://www.prisma.io/) like ORM style** client for [rqlite](https://github.com/rqlite/rqlite). It provides a type-safe(ish) JavaScript API to interact with your distributed SQLite database, handling connections, query building, and **safe schema migrations** automatically.

## Features

- 🚀 **Prisma-like API**: `findMany`, `findUnique`, `create`, `update`, `delete`.
- 🛡️ **Safe Migrations**: `initDB()` automatically creates tables and adds missing columns without data loss.
- 🔍 **Powerful Filtering**: Support for `gt`, `lt`, `contains`, `startsWith`, `in`, `OR`, `NOT`, and more.
- ⚡ **Multi-Port Support**: Easily manage sharded databases across different rqlite ports.
- 🔑 **Composite Keys**: Support for composite unique constraints (e.g., `(user_id, post_id)`).
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

Create a `schema.js` file to define your database structure.

```javascript
// schema.js
export const schema = {
  // Standard Table with Primary Key
  users: {
    port: 4001, // rqlite port for this table
    primaryKey: "id", // Optional: Helps optimize updates
    fields: {
      id: { type: "INTEGER", pk: true, autoIncrement: true },
      email: { type: "TEXT", notNull: true },
      name: { type: "TEXT" },
      age: { type: "INTEGER" },
      is_active: { type: "INTEGER", default: 1 },
      created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" }
    },
    indexes: [
      { name: "uq_users_email", columns: ["email"], unique: true }
    ]
  },
  
  // Table with Composite Key (No single PK)
  likes: {
    port: 4001,
    fields: {
      user_id: { type: "INTEGER" },
      post_id: { type: "INTEGER" },
      created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" }
    },
    indexes: [
      // Composite Unique Constraint acts as the "Key"
      { name: "uq_likes", columns: ["user_id", "post_id"], unique: true }
    ]
  }
};
```

### 2. Initialize the Client & Database

Import `createClient` and your schema to start.

```javascript
import { createClient } from "rqlink";
import { schema } from "./schema.js";

// Create the client instance
const { db, initDB } = createClient(schema);

async function main() {
  // Initialize tables (Safe Migration)
  await initDB({ verbose: true });
  console.log("Database initialized!");

  // Use the client
  const user = await db.users.create({
    data: {
      name: "Alice",
      email: "alice@example.com",
      age: 25
    }
  });
  console.log("Created:", user);
}

main();
```

> **🛡️ Safety Note:** `initDB` checks your schema against the actual database. If you add new fields to your `schema.js`, `initDB` will automatically `ALTER TABLE` to add them. **It will NEVER delete columns or drop tables**, ensuring your data is safe.

---

## API Reference

### `createClient(schema)`

Returns an object with:
- `db`: The query builder interface (e.g., `db.users.findMany`).
- `initDB({ verbose })`: Function to initialize/migrate the DB.
- `dropDB({ verbose })`: Function to drop all tables (Destructive!).

### `db.<table>.findMany({ where, select, orderBy, limit, offset })`

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

### `db.<table>.findUnique({ where, select })`

Retrieve a single record. Best used with unique fields like IDs or emails.

```javascript
const user = await db.users.findUnique({
  where: { email: "alice@example.com" }
});
// Returns: { id: 1, name: "Alice", ... } or null
```

### `db.<table>.findFirst({ where, select, orderBy })`

Retrieve the first record matching the criteria.

```javascript
const latestPost = await db.posts.findFirst({
  where: { user_id: 1 },
  orderBy: { created_at: "desc" }
});
// Returns: { id: "post_123", title: "My First Post", ... } or null
```

### `db.<table>.create({ data, select })`

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

### `db.<table>.update({ where, data, select })`

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

**Note on Primary Keys**: If your table has a `primaryKey` defined in the schema, `update` will attempt to fetch the updated record efficiently. If not (e.g., composite keys), it will try to find the first record matching your `where` clause.

### `db.<table>.delete({ where })`

Delete records.

```javascript
await db.users.delete({
  where: { id: 1 }
});
// Returns: true
```

### `db.<table>.count({ where })`

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
