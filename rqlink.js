// rqliteClient.js
// rqliteClient.js
// rqlink.js

/**
 * Lightweight Prisma-style rqlite client
 *
 * Features:
 * - initDB() : create tables and indexes, and performs safe schema migrations (adds missing columns).
 * - db.<table>.create({ data, select }) : Inserts data and returns the created row (optimized with RETURNING).
 * - db.<table>.findMany({ where, select, orderBy, limit, offset }) : Powerful filtering and pagination.
 * - db.<table>.findUnique({ where, select }) : Fetch single record by unique constraints.
 * - db.<table>.findFirst({ where, select, orderBy }) : Fetch first record matching criteria.
 * - db.<table>.update({ where, data, select }) : Updates records and returns the updated data.
 * - db.<table>.delete({ where }) : Deletes records.
 * - db.<table>.count({ where }) : Counts records matching criteria.
 *
 * Advanced Filtering (where):
 * - equals (implicit): { name: "John" }
 * - Operators: { age: { gt: 18 } } (gt, gte, lt, lte, not)
 * - String: { name: { contains: "jo", startsWith: "J", endsWith: "n" } }
 * - List: { id: { in: [1, 2, 3] } }
 * - Logical: { OR: [ ... ], NOT: { ... } }
 */

// ---------------------- CONFIGURATION ----------------------

/**
 * Global configuration object.
 * @property {string} baseUrl - The base URL of the rqlite node (e.g., "http://localhost").
 * @property {number} timeout - Request timeout in milliseconds.
 * @property {boolean} verbose - If true, logs all SQL queries to console.
 */
let CONFIG = {
  baseUrl: "http://localhost",
  timeout: 8000,
  verbose: false
};

/**
 * Updates the client configuration.
 * @param {Object} options - Configuration options to override.
 */
export function configure(options = {}) {
  CONFIG = { ...CONFIG, ...options };
}

const VALID_NAME = /^[a-zA-Z0-9_]+$/;
const SQLITE_TYPES = new Set(["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"]);

// ---------------------- VALIDATION ----------------------

/**
 * Validates the schema definition to ensure table and column names are safe
 * and types are valid SQLite types.
 * @param {Object} s - The schema object.
 */
function validateSchema(s) {
  for (const t of Object.keys(s)) {
    if (!VALID_NAME.test(t)) throw new Error(`Invalid table name "${t}"`);
    const cfg = s[t];
    if (!cfg.port) throw new Error(`Table ${t} missing port`);
    if (!cfg.fields || typeof cfg.fields !== "object") throw new Error(`Table ${t} missing fields`);
    for (const [col, def] of Object.entries(cfg.fields)) {
      if (!VALID_NAME.test(col)) throw new Error(`Invalid column name "${col}" in ${t}`);
      if (!def.type || !SQLITE_TYPES.has(def.type.toUpperCase())) {
        throw new Error(`Invalid or missing type for ${t}.${col}. Allowed: ${[...SQLITE_TYPES].join(", ")}`);
      }
      if (def.autoIncrement && def.type.toUpperCase() !== "INTEGER") {
        throw new Error(`autoIncrement can only be used with INTEGER type: ${t}.${col}`);
      }
    }
  }
}

// ---------------------- NETWORK LAYER ----------------------

/**
 * Sends a raw HTTP request to the rqlite server.
 * Handles timeouts and parses the JSON response.
 * @param {number} port - The port of the rqlite node (for multi-db setups).
 * @param {string} path - The API path (e.g., "/db/execute").
 * @param {Object} payload - The JSON payload for the request.
 */
async function rqliteRequest(port, path, payload) {
  const url = `${CONFIG.baseUrl}:${port}${path}`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), CONFIG.timeout);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    clearTimeout(id);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const json = await res.json();
    // Check for rqlite-level errors in the results
    const err = json.results?.[0]?.error;
    if (err) throw new Error(err);

    return json;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

/**
 * Executes a SQL statement (INSERT, UPDATE, DELETE, CREATE, DROP).
 * @param {number} port - The DB port.
 * @param {string} sql - The SQL string.
 * @param {Object} params - Named parameters for the query.
 */
export async function executeSQL(port, sql, params = {}) {
  if (CONFIG.verbose) console.log(`EXEC [${port}]:`, sql, params);
  return await rqliteRequest(port, "/db/execute", [[sql, params]]);
}

/**
 * Executes a SQL query (SELECT).
 * Uses level=strong to ensure strong consistency (read-your-writes).
 * @param {number} port - The DB port.
 * @param {string} sql - The SQL string.
 * @param {Object} params - Named parameters.
 */
export async function querySQL(port, sql, params = {}) {
  if (CONFIG.verbose) console.log(`QUERY [${port}]:`, sql, params);
  // Use level=strong to ensure we read the latest writes (critical for read-after-write)
  const res = await rqliteRequest(port, "/db/query?level=strong", [[sql, params]]);

  if (res.error) return res;

  const r = res.results?.[0] || {};
  const cols = r.columns || [];
  const rows = r.values || [];
  // Map array results to objects with column names
  return rows.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// ---------------------- QUERY BUILDER HELPERS ----------------------

/**
 * Builds the SELECT clause.
 * @param {Object} select - User provided select object { name: true, id: true }.
 * @param {Array} availableFields - List of valid fields for the table.
 */
function buildSelect(select, availableFields) {
  if (!select || Object.keys(select).length === 0) return "*";
  const cols = [];
  for (const [key, val] of Object.entries(select)) {
    if (val && availableFields.includes(key)) {
      cols.push(key);
    } else if (val) {
      throw new Error(`Unknown field in select: ${key}`);
    }
  }
  return cols.length > 0 ? cols.join(", ") : "*";
}

/**
 * Recursively builds the WHERE clause and collects parameters.
 * Supports nested logic (OR, NOT) and operators (gt, lt, contains, etc.).
 * @param {Object} where - The where clause object.
 * @param {Array} availableFields - Valid fields.
 * @param {string} paramPrefix - Prefix for named parameters to avoid collisions.
 */
function buildWhere(where, availableFields, paramPrefix = "w") {
  if (!where || Object.keys(where).length === 0) return { clause: "1=1", params: {} };

  const conditions = [];
  const params = {};
  let paramIdx = 0;

  function addParam(val) {
    const name = `${paramPrefix}_${paramIdx++}`;
    params[name] = val;
    return `:${name}`;
  }

  function processCondition(key, val) {
    // Handle Logical Operators
    if (key === "OR") {
      if (!Array.isArray(val)) throw new Error("OR must be an array");
      const orClauses = val.map(subWhere => {
        const { clause, params: subParams } = buildWhere(subWhere, availableFields, `${paramPrefix}_or${paramIdx++}`);
        Object.assign(params, subParams);
        return `(${clause})`;
      });
      return `(${orClauses.join(" OR ")})`;
    }
    if (key === "NOT") {
      const { clause, params: subParams } = buildWhere(val, availableFields, `${paramPrefix}_not${paramIdx++}`);
      Object.assign(params, subParams);
      return `NOT (${clause})`;
    }

    if (!availableFields.includes(key)) throw new Error(`Unknown field in where: ${key}`);

    if (val === null) return `${key} IS NULL`;
    if (typeof val !== "object") return `${key} = ${addParam(val)}`; // Implicit equals

    // Handle Field Operators
    const subClauses = [];
    for (const [op, opVal] of Object.entries(val)) {
      switch (op) {
        case "equals": subClauses.push(`${key} = ${addParam(opVal)}`); break;
        case "not": subClauses.push(`${key} != ${addParam(opVal)}`); break;
        case "gt": subClauses.push(`${key} > ${addParam(opVal)}`); break;
        case "gte": subClauses.push(`${key} >= ${addParam(opVal)}`); break;
        case "lt": subClauses.push(`${key} < ${addParam(opVal)}`); break;
        case "lte": subClauses.push(`${key} <= ${addParam(opVal)}`); break;
        case "contains": subClauses.push(`${key} LIKE ${addParam(`%${opVal}%`)}`); break;
        case "startsWith": subClauses.push(`${key} LIKE ${addParam(`${opVal}%`)}`); break;
        case "endsWith": subClauses.push(`${key} LIKE ${addParam(`%${opVal}`)}`); break;
        case "in":
          if (!Array.isArray(opVal) || opVal.length === 0) {
            subClauses.push("1=0"); // Empty in list matches nothing
          } else {
            const inParams = opVal.map(v => addParam(v));
            subClauses.push(`${key} IN (${inParams.join(", ")})`);
          }
          break;
        default: throw new Error(`Unknown operator ${op} for field ${key}`);
      }
    }
    return subClauses.join(" AND ");
  }

  for (const [key, val] of Object.entries(where)) {
    conditions.push(processCondition(key, val));
  }

  return { clause: conditions.join(" AND "), params };
}

// ---------------------- MODEL FACTORY ----------------------

/**
 * Creates the CRUD interface for a specific table.
 * @param {string} tableName - Name of the table.
 * @param {Object} cfg - Table configuration (port, fields, etc.).
 */
function buildModel(tableName, cfg) {
  const port = cfg.port;
  const fields = Object.keys(cfg.fields);
  const pk = cfg.primaryKey || Object.keys(cfg.fields).find(k => cfg.fields[k].pk) || null;

  return {
    /**
     * Creates a new record.
     * Uses INSERT ... RETURNING * for efficiency.
     */
    async create({ data, select }) {
      if (!data || typeof data !== "object") throw new Error("create requires data object");
      const cols = Object.keys(data);
      for (const c of cols) {
        if (!fields.includes(c)) throw new Error(`Unknown column "${c}"`);
      }

      const placeholders = cols.map(c => `:${c}`);
      // OPTIMIZATION: Use RETURNING * to get the created row in one round-trip
      const sql = `INSERT INTO ${tableName} (${cols.join(", ")}) VALUES (${placeholders.join(", ")}) RETURNING *;`;

      // We use executeSQL but rqlite returns query-like results for RETURNING
      const res = await executeSQL(port, sql, data);

      // Parse result
      const r = res.results?.[0] || {};
      const resCols = r.columns || [];
      const resRows = r.values || [];

      if (resRows.length > 0) {
        const row = resRows[0];
        const obj = {};
        resCols.forEach((c, i) => obj[c] = row[i]);

        // If specific select requested, filter it in memory (since we fetched *)
        if (select) {
          const filtered = {};
          for (const k of Object.keys(select)) {
            if (select[k]) filtered[k] = obj[k];
          }
          return filtered;
        }
        return obj;
      }

      return data; // Fallback
    },

    /**
     * Finds multiple records matching criteria.
     */
    async findMany({ where, select, orderBy, limit, offset } = {}) {
      const { clause, params } = buildWhere(where, fields);
      const sel = buildSelect(select, fields);

      let sql = `SELECT ${sel} FROM ${tableName} WHERE ${clause}`;

      if (orderBy) {
        const orderCols = [];
        const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
        for (const o of orders) {
          for (const [col, dir] of Object.entries(o)) {
            if (!fields.includes(col)) throw new Error(`Invalid orderBy column ${col}`);
            orderCols.push(`${col} ${dir.toUpperCase()}`);
          }
        }
        if (orderCols.length > 0) sql += ` ORDER BY ${orderCols.join(", ")}`;
      }

      if (limit !== undefined) sql += ` LIMIT ${Number(limit)}`;
      if (offset !== undefined) sql += ` OFFSET ${Number(offset)}`;

      return await querySQL(port, sql, params);
    },

    /**
     * Finds a single unique record.
     */
    async findUnique({ where, select }) {
      const rows = await this.findMany({ where, select, limit: 1 });
      return rows[0] || null;
    },

    /**
     * Finds the first record matching criteria.
     */
    async findFirst({ where, select, orderBy }) {
      const rows = await this.findMany({ where, select, orderBy, limit: 1 });
      return rows[0] || null;
    },

    /**
     * Updates records matching criteria.
     * Note: SQLite/rqlite doesn't support UPDATE ... RETURNING easily in all versions/modes,
     * so we attempt to fetch the updated record if a PK is provided.
     */
    /**
     * Updates records matching criteria.
     * Uses UPDATE ... RETURNING * to get the updated records in a single round-trip.
     */
    async update({ where, data, select }) {
      if (!where || Object.keys(where).length === 0) throw new Error("update requires where");
      if (!data || Object.keys(data).length === 0) throw new Error("update requires data");

      const setCols = Object.keys(data);
      for (const c of setCols) {
        if (!fields.includes(c)) throw new Error(`Unknown column "${c}"`);
      }

      const setClause = setCols.map(c => `${c} = :set_${c}`).join(", ");
      const { clause: whereClause, params: whereParams } = buildWhere(where, fields);

      const params = { ...whereParams };
      for (const c of setCols) params[`set_${c}`] = data[c];

      // OPTIMIZATION: Use RETURNING * to fetch updated rows immediately
      const sql = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause} RETURNING *;`;

      const res = await executeSQL(port, sql, params);

      // Parse result
      const r = res.results?.[0] || {};
      const resCols = r.columns || [];
      const resRows = r.values || [];

      if (resRows.length > 0) {
        // Return the first updated record (Prisma style usually returns one)
        // If multiple were updated, this returns the first one.
        const row = resRows[0];
        const obj = {};
        resCols.forEach((c, i) => obj[c] = row[i]);

        if (select) {
          const filtered = {};
          for (const k of Object.keys(select)) {
            if (select[k]) filtered[k] = obj[k];
          }
          return filtered;
        }
        return obj;
      }

      return null; // No record updated
    },

    /**
     * Deletes records matching criteria.
     */
    async delete({ where }) {
      if (!where || Object.keys(where).length === 0) throw new Error("delete requires where");
      const { clause, params } = buildWhere(where, fields);
      const sql = `DELETE FROM ${tableName} WHERE ${clause};`;
      await executeSQL(port, sql, params);
      return true; // Prisma returns the deleted object, but that requires a SELECT before DELETE
    },

    /**
     * Counts records matching criteria.
     */
    async count({ where } = {}) {
      const { clause, params } = buildWhere(where, fields);
      const sql = `SELECT COUNT(1) AS count FROM ${tableName} WHERE ${clause};`;
      const rows = await querySQL(port, sql, params);
      return (rows[0] && rows[0].count) ? Number(rows[0].count) : 0;
    }
  };
}

// ---------------------- INIT & EXPORT ----------------------

/**
 * Generates the SQL string for a column definition (e.g., "id INTEGER PRIMARY KEY AUTOINCREMENT").
 * @param {string} name - Column name.
 * @param {Object} def - Column definition from schema.
 */
function columnDefSQL(name, def) {
  const parts = [name, def.type.toUpperCase()];
  if (def.pk) parts.push("PRIMARY KEY");
  if (def.autoIncrement) parts.push("AUTOINCREMENT");
  if (def.notNull) parts.push("NOT NULL");
  if (def.default !== undefined) parts.push(`DEFAULT ${def.default}`);
  return parts.join(" ");
}

/**
 * Initializes the database tables based on the schema.
 * Performs SAFE MIGRATIONS:
 * - Checks if tables exist.
 * - If table exists, checks for missing columns and adds them (ALTER TABLE).
 * - Creates indexes.
 * 
 * @param {Object} schemaDef - The schema object.
 * @param {boolean} verbose - If true, logs SQL commands.
 */
async function initDBSchema(schemaDef, verbose = false) {
  if (verbose) configure({ verbose: true });
  validateSchema(schemaDef);

  for (const [tableName, cfg] of Object.entries(schemaDef)) {
    const port = cfg.port;
    const colDefs = Object.entries(cfg.fields).map(([col, def]) => columnDefSQL(col, def));
    const createSQL = `CREATE TABLE IF NOT EXISTS ${tableName} (${colDefs.join(", ")});`;

    await executeSQL(port, createSQL);

    // --- MIGRATION: Check for missing columns and ADD them ---
    // 1. Get existing columns
    const pragmaSQL = `PRAGMA table_info(${tableName})`;
    const pragmaRes = await querySQL(port, pragmaSQL);
    // pragmaRes is array of { cid, name, type, notnull, dflt_value, pk }
    const existingCols = new Set(pragmaRes.map(row => row.name));

    // 2. Find missing columns in schema
    for (const [colName, colDef] of Object.entries(cfg.fields)) {
      if (!existingCols.has(colName)) {
        if (verbose) console.log(`[MIGRATION] Adding column ${tableName}.${colName}`);

        // Construct column definition for ALTER TABLE
        // Note: SQLite ALTER TABLE ADD COLUMN has some restrictions (e.g. can't be PRIMARY KEY, UNIQUE)
        // But for standard fields it's fine.
        const defSQL = columnDefSQL(colName, colDef);
        const alterSQL = `ALTER TABLE ${tableName} ADD COLUMN ${defSQL};`;

        try {
          await executeSQL(port, alterSQL);
        } catch (e) {
          console.error(`[MIGRATION ERROR] Failed to add column ${tableName}.${colName}:`, e.message);
          // Don't throw, try next column
        }
      }
    }

    if (Array.isArray(cfg.indexes)) {
      for (const idx of cfg.indexes) {
        if (!Array.isArray(idx.columns) || idx.columns.length === 0) continue;
        const name = idx.name || `idx_${tableName}_${idx.columns.join("_")}`;
        const unique = idx.unique ? "UNIQUE" : "";
        const idxSQL = `CREATE ${unique} INDEX IF NOT EXISTS ${name} ON ${tableName} (${idx.columns.join(", ")});`;
        await executeSQL(port, idxSQL);
      }
    }
  }
  return true;
}

/**
 * Drops all tables in the schema.
 * WARNING: DESTRUCTIVE OPERATION.
 * @param {Object} schemaDef - The schema object.
 * @param {boolean} verbose - If true, logs SQL commands.
 */
async function dropDBSchema(schemaDef, verbose = false) {
  if (verbose) console.log("Dropping all tables...");
  for (const [tableName, cfg] of Object.entries(schemaDef)) {
    const port = cfg.port;
    await executeSQL(port, `DROP TABLE IF EXISTS ${tableName};`);
  }
  return true;
}

/**
 * Creates a client instance for a given schema.
 * Returns an object with:
 * - db: The query builder interface.
 * - initDB: Function to initialize the DB for this schema.
 * - dropDB: Function to drop the DB for this schema.
 * 
 * @param {Object} schemaDef - The schema definition object.
 */
export function createClient(schemaDef) {
  validateSchema(schemaDef);

  // Build the DB interface
  const dbInterface = {};
  for (const t of Object.keys(schemaDef)) {
    dbInterface[t] = buildModel(t, schemaDef[t]);
  }

  return {
    db: dbInterface,
    initDB: (opts = {}) => initDBSchema(schemaDef, opts.verbose),
    dropDB: (opts = {}) => dropDBSchema(schemaDef, opts.verbose)
  };
}

export default { configure, createClient, executeSQL, querySQL };
