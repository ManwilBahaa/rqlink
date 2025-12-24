/**
 * Rqlink - A lightweight, Prisma-style ORM for rqlite
 * 
 * This module provides a type-safe, distributed database client for rqlite
 * with automatic failover, batch operations, and safe query building.
 * 
 * @module rqlink
 */

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Global configuration object for rqlink behavior
 * @property {number} timeout - Request timeout in milliseconds (default: 5000)
 * @property {boolean} verbose - Enable SQL query logging in development (default: false)
 * @property {string} freshness - Freshness parameter for read consistency (default: "0.1s")
 * @property {boolean} freshness_strict - Enable strict freshness checking (default: true)
 * @property {number} retryDelay - Base delay between retries in milliseconds (default: 50)
 * @property {number} maxRequestSize - Maximum request payload size in bytes (default: 1MB)
 * @property {boolean} requireTLS - Require HTTPS connections (default: false, set true for PHI/EMR)
 */
let CONFIG = {
  timeout: 5000,
  verbose: false,
  freshness: "0.1s",
  freshness_strict: true,
  retryDelay: 50,
  maxRequestSize: 1024 * 1024, // 1MB limit to prevent DoS
  requireTLS: false // Set to true for PHI/EMR production environments
};

// ============================================================================
// SCHEMA CACHE WITH TTL
// ============================================================================

/**
 * Cache for storing table schema information with automatic expiration
 * Prevents repeated PRAGMA calls while ensuring schema freshness
 */
const schemaCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes TTL for schema cache
const MAX_CACHE_SIZE = 100; // Maximum number of cached schemas to prevent memory leaks

/**
 * Retrieves cached schema data if it exists and hasn't expired
 * @param {string} key - Cache key (tableName|port format)
 * @returns {Object|null} Cached schema data or null if expired/missing
 */
function getCachedSchema(key) {
  const entry = schemaCache.get(key);
  if (!entry) return null;

  // Check if cache entry has expired
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    schemaCache.delete(key);
    return null;
  }
  return entry.data;
}

/**
 * Stores schema data in cache with timestamp
 * Implements LRU-style eviction when cache is full
 * @param {string} key - Cache key
 * @param {Object} data - Schema data to cache
 */
function setCachedSchema(key, data) {
  // Evict oldest entry if cache is at capacity
  if (schemaCache.size >= MAX_CACHE_SIZE) {
    const oldest = schemaCache.keys().next().value;
    schemaCache.delete(oldest);
  }
  schemaCache.set(key, { data, timestamp: Date.now() });
}

/**
 * Manually invalidates a cache entry
 * @param {string} key - Cache key to invalidate
 */
function invalidateCache(key) {
  schemaCache.delete(key);
}

// ============================================================================
// VALIDATION CONSTANTS AND FUNCTIONS
// ============================================================================

/**
 * Valid identifier regex - allows alphanumeric and underscore only
 * This is intentionally restrictive for security - SQLite identifiers are quoted
 */
const VALID_NAME = /^[a-zA-Z0-9_]+$/;

/**
 * Allowed SQLite column types
 */
const SQLITE_TYPES = new Set(["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"]);

/**
 * Safe regex for math expressions - allows basic arithmetic only
 * Characters allowed: letters, numbers, underscore, quotes, parentheses, 
 * arithmetic operators, whitespace, colon (for named params), decimal point
 */
const MATH_SAFE_REGEX = /^[a-zA-Z0-9_"()+\-*/\s:.]+$/;

/**
 * Blocked SQL patterns in math expressions to prevent injection
 * These patterns are checked case-insensitively
 */
const MATH_BLOCKED_PATTERNS = [
  ';',      // Statement terminator
  '--',     // SQL comment
  '/*',     // Block comment start
  '*/',     // Block comment end
  'UNION',  // SQL UNION attack
  'SELECT', // SELECT injection
  'INSERT', // INSERT injection
  'DELETE', // DELETE injection
  'DROP',   // DROP injection
  'UPDATE', // UPDATE injection
  'CREATE', // CREATE injection
  'ALTER',  // ALTER injection
  'EXEC',   // EXEC injection
  'EXECUTE' // EXECUTE injection
];

/**
 * Validates a math expression for safety against SQL injection
 * Uses both regex validation and keyword blocklist
 * @param {string} expr - The math expression to validate
 * @returns {boolean} True if expression is safe, false otherwise
 */
function validateMathExpression(expr) {
  // First check against basic character whitelist
  if (!MATH_SAFE_REGEX.test(expr)) {
    return false;
  }

  // Then check for blocked SQL patterns (case-insensitive)
  const upperExpr = expr.toUpperCase();
  for (const pattern of MATH_BLOCKED_PATTERNS) {
    if (upperExpr.includes(pattern)) {
      return false;
    }
  }

  return true;
}

/**
 * Quotes an identifier for safe use in SQL statements
 * Uses double quotes as per SQLite standard
 * @param {string} name - The identifier to quote
 * @returns {string} Quoted identifier
 */
function quote(name) {
  return `"${name}"`;
}

/**
 * Validates a complete schema definition
 * Checks table names, column names, types, and configuration
 * @param {Object} s - Schema definition object
 * @throws {Error} If schema validation fails
 */
function validateSchema(s) {
  for (const t of Object.keys(s)) {
    // Validate table name
    if (!VALID_NAME.test(t)) {
      throw new Error(`Invalid table name: ${t}. Only alphanumeric and underscore allowed.`);
    }

    const cfg = s[t];

    // Validate config exists
    if (!cfg.config || typeof cfg.config !== "object") {
      throw new Error(`Missing config for table: ${t}`);
    }

    const { base, port } = cfg.config;

    // Validate base URLs and port
    if (!port || typeof port !== "number") {
      throw new Error(`Invalid port for table: ${t}`);
    }
    if (!Array.isArray(base) || base.length === 0) {
      throw new Error(`Invalid base URLs for table: ${t}. Must be non-empty array.`);
    }

    // Validate each field definition
    for (const [col, def] of Object.entries(cfg.fields)) {
      // Validate column name
      if (!VALID_NAME.test(col)) {
        throw new Error(`Invalid column name: ${col} in table ${t}`);
      }

      // Validate column type
      if (!def.type || !SQLITE_TYPES.has(def.type.toUpperCase())) {
        throw new Error(`Invalid type for ${t}.${col}. Must be one of: ${[...SQLITE_TYPES].join(', ')}`);
      }

      // Validate default value if present
      if (def.default !== undefined) {
        const defVal = def.default;
        const defType = typeof defVal;

        // Only allow safe default value types
        if (defType !== "string" && defType !== "number" && defType !== "boolean") {
          throw new Error(`Invalid default value type for ${t}.${col}. Must be string, number, or boolean.`);
        }

        // Check string defaults for potential injection
        if (defType === "string" && !(/^[A-Z_]+$/.test(defVal) || /^[a-zA-Z0-9_\s\-.]+$/.test(defVal))) {
          throw new Error(`Unsafe default value for ${t}.${col}. Contains potentially dangerous characters.`);
        }
      }
    }
  }
}

// ============================================================================
// CONFIGURATION API
// ============================================================================

/**
 * Configures global rqlink settings
 * Merges provided options with existing configuration
 * @param {Object} options - Configuration options to set
 * @example
 * configure({ timeout: 10000, verbose: true });
 */
export function configure(options = {}) {
  CONFIG = { ...CONFIG, ...options };
}

// ============================================================================
// URL SORTING AND REQUEST HANDLING
// ============================================================================

/**
 * Sorts base URLs to prioritize localhost connections
 * This optimization reduces latency for single-node development setups
 * @param {string[]} urls - Array of base URLs
 * @returns {string[]} Sorted URL array with localhost first
 */
function sortBaseUrls(urls) {
  return [...urls].sort((a, b) => {
    const aLocal = a.includes("localhost") || a.includes("127.0.0.1");
    const bLocal = b.includes("localhost") || b.includes("127.0.0.1");
    return aLocal === bLocal ? 0 : aLocal ? -1 : 1;
  });
}

/**
 * Makes an HTTP request to rqlite with automatic failover
 * Tries each base URL in sequence until one succeeds
 * @param {string[]} baseUrls - Array of rqlite base URLs to try
 * @param {number} port - rqlite HTTP port
 * @param {string} path - API endpoint path (e.g., "/db/execute")
 * @param {Object} payload - Request body to send as JSON
 * @param {Object|null} auth - Optional authentication credentials {username, password}
 * @returns {Promise<Object>} Parsed JSON response from rqlite
 * @throws {Error} If all URLs fail or request times out
 */
async function rqliteRequest(baseUrls, port, path, payload, auth = null) {
  let lastError = null;
  let attempt = 0;

  // Validate payload size to prevent DoS
  const payloadStr = JSON.stringify(payload);
  if (payloadStr.length > CONFIG.maxRequestSize) {
    throw new Error(`Request payload too large: ${payloadStr.length} bytes exceeds limit of ${CONFIG.maxRequestSize} bytes`);
  }

  // Try each base URL in sequence
  for (const baseUrl of baseUrls) {
    // Enforce TLS if requireTLS is enabled (for PHI/EMR compliance)
    if (CONFIG.requireTLS && !baseUrl.startsWith("https://")) {
      throw new Error(`Insecure connection blocked: ${baseUrl}. requireTLS is enabled.`);
    }

    // Apply exponential backoff delay after first attempt
    if (attempt > 0 && CONFIG.retryDelay > 0) {
      await new Promise(r => setTimeout(r, CONFIG.retryDelay * attempt));
    }
    attempt++;

    const url = `${baseUrl}:${port}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), CONFIG.timeout);

    try {
      // Build request headers
      const headers = { "Content-Type": "application/json" };

      // Add Basic Auth if credentials provided
      if (auth?.username && auth?.password) {
        headers["Authorization"] = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
      }

      // Make the HTTP request
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: payloadStr,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      // Check for HTTP errors
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      // Parse and validate response
      const json = await res.json();
      const results = json.results || [];

      // Check for rqlite-level errors in results
      for (const r of results) {
        if (r.error) {
          throw new Error(`rqlite Error: ${r.error}`);
        }
      }

      return json;
    } catch (e) {
      clearTimeout(timeoutId);
      lastError = e;
      // Continue to next URL on failure
    }
  }

  // All URLs failed
  throw new Error(`rqlite unreachable after ${attempt} attempts: ${lastError?.message}`);
}

// ============================================================================
// SQL EXECUTION AND QUERY FUNCTIONS
// ============================================================================

/**
 * Executes a write SQL statement (INSERT, UPDATE, DELETE)
 * @param {string[]} baseUrls - rqlite base URLs
 * @param {number} port - rqlite HTTP port
 * @param {string} sql - SQL statement to execute
 * @param {Object} params - Named parameters for the query
 * @param {Object|null} auth - Optional authentication credentials
 * @returns {Promise<Object>} Query execution result
 */
export async function executeSQL(baseUrls, port, sql, params = {}, auth = null) {
  // Only log in verbose mode during development - truncate for safety
  if (CONFIG.verbose && process.env.NODE_ENV !== "production") {
    const truncatedSql = sql.length > 200 ? sql.substring(0, 200) + "..." : sql;
    console.log(`EXEC: ${truncatedSql}`, `[${Object.keys(params).length} params]`);
  }

  return await rqliteRequest(baseUrls, port, "/db/execute?named_parameters", [[sql, params]], auth);
}

/**
 * Executes a read SQL statement (SELECT)
 * Supports configurable consistency levels and freshness settings
 * @param {string[]} baseUrls - rqlite base URLs
 * @param {number} port - rqlite HTTP port
 * @param {string} sql - SQL SELECT statement
 * @param {Object} params - Named parameters for the query
 * @param {Object|null} auth - Optional authentication credentials
 * @param {string|null} levelOverride - Optional consistency level override ("strong"|"none")
 * @returns {Promise<Object[]>} Array of result row objects
 */
export async function querySQL(baseUrls, port, sql, params = {}, auth = null, levelOverride = null) {
  // Only log in verbose mode during development - truncate for safety
  if (CONFIG.verbose && process.env.NODE_ENV !== "production") {
    const truncatedSql = sql.length > 200 ? sql.substring(0, 200) + "..." : sql;
    console.log(`QUERY: ${truncatedSql}`, `[${Object.keys(params).length} params]`);
  }

  let res;

  // Determine consistency level - PRAGMA always uses strong consistency
  const level = levelOverride || (/^\s*PRAGMA/i.test(sql) ? "strong" : "none");
  const baseParams = "named_parameters";

  if (level === "strong") {
    // Strong consistency - reads from leader
    res = await rqliteRequest(baseUrls, port, `/db/query?${baseParams}&level=strong`, [[sql, params]], auth);
  } else {
    // Relaxed consistency with freshness parameter
    const strict = CONFIG.freshness_strict ? "&freshness_strict" : "";
    res = await rqliteRequest(
      baseUrls,
      port,
      `/db/query?${baseParams}&level=none&freshness=${CONFIG.freshness}${strict}`,
      [[sql, params]],
      auth
    );
  }

  // Transform column/value arrays to row objects
  const r = res.results?.[0] || {};
  const cols = r.columns || [];
  const rows = r.values || [];

  return rows.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });
}

// ============================================================================
// QUERY BUILDER HELPERS
// ============================================================================

/**
 * Builds a SELECT column list from a select object
 * @param {Object|null} select - Object specifying which columns to select
 * @param {string[]} availableFields - List of valid field names
 * @returns {string} SQL column list or "*"
 */
function buildSelect(select, availableFields) {
  if (!select || Object.keys(select).length === 0) {
    return "*";
  }

  const cols = Object.keys(select)
    .filter(k => select[k] && availableFields.includes(k))
    .map(quote);

  return cols.length > 0 ? cols.join(", ") : "*";
}

/**
 * Builds a WHERE clause from a filter object
 * Supports operators: equals, not, gt, gte, lt, lte, contains, startsWith, endsWith, in
 * Also supports OR and NOT logical operators
 * @param {Object|null} where - Filter conditions
 * @param {string[]} availableFields - List of valid field names
 * @returns {Object} Object with {clause: string, params: Object}
 */
function buildWhere(where, availableFields) {
  if (!where || Object.keys(where).length === 0) {
    return { clause: "1=1", params: {} };
  }

  const params = {};
  let idx = 0;

  /**
   * Adds a parameter value and returns its placeholder
   * Uses unique indexed keys to prevent collisions
   */
  const addParam = (val) => {
    const key = `p_${idx++}`;
    params[key] = val;
    return `:${key}`;
  };

  /**
   * Recursively processes where conditions
   * @param {Object} w - Where condition object
   * @returns {string} SQL WHERE clause fragment
   */
  const process = (w) => {
    const parts = [];

    for (const [key, val] of Object.entries(w)) {
      // Handle OR operator
      if (key === "OR") {
        parts.push(`(${val.map(v => process(v)).join(" OR ")})`);
      }
      // Handle NOT operator
      else if (key === "NOT") {
        parts.push(`NOT (${process(val)})`);
      }
      // Handle field conditions
      else {
        // Validate field exists in schema
        if (!availableFields.includes(key)) {
          throw new Error(`Field "${key}" not found in schema`);
        }

        const qk = quote(key);

        // Handle NULL check
        if (val === null) {
          parts.push(`${qk} IS NULL`);
        }
        // Handle simple equality
        else if (typeof val !== "object") {
          parts.push(`${qk} = ${addParam(val)}`);
        }
        // Handle comparison operators
        else {
          for (const [op, opV] of Object.entries(val)) {
            switch (op) {
              case "equals":
                parts.push(`${qk} = ${addParam(opV)}`);
                break;
              case "not":
                parts.push(`${qk} != ${addParam(opV)}`);
                break;
              case "gt":
                parts.push(`${qk} > ${addParam(opV)}`);
                break;
              case "gte":
                parts.push(`${qk} >= ${addParam(opV)}`);
                break;
              case "lt":
                parts.push(`${qk} < ${addParam(opV)}`);
                break;
              case "lte":
                parts.push(`${qk} <= ${addParam(opV)}`);
                break;
              case "contains":
                parts.push(`${qk} LIKE ${addParam(`%${opV}%`)}`);
                break;
              case "startsWith":
                parts.push(`${qk} LIKE ${addParam(`${opV}%`)}`);
                break;
              case "endsWith":
                parts.push(`${qk} LIKE ${addParam(`%${opV}`)}`);
                break;
              case "in":
                if (opV.length === 0) {
                  parts.push("1=0"); // Empty IN clause always false
                } else {
                  parts.push(`${qk} IN (${opV.map(v => addParam(v)).join(", ")})`);
                }
                break;
              default:
                throw new Error(`Unknown operator: ${op}`);
            }
          }
        }
      }
    }

    return parts.join(" AND ");
  };

  return { clause: process(where), params };
}

// ============================================================================
// MODEL BUILDER
// ============================================================================

/**
 * Builds a model object with CRUD methods for a table
 * @param {string} tableName - Name of the table
 * @param {Object} cfg - Table configuration from schema
 * @returns {Object} Model object with create, findMany, update, delete, count methods
 */
function buildModel(tableName, cfg) {
  const baseUrls = sortBaseUrls(cfg.config.base);
  const { port, username, password } = cfg.config;
  const auth = (username && password) ? { username, password } : null;
  const fields = Object.keys(cfg.fields);
  const qTable = quote(tableName);

  return {
    /**
     * Creates a new record in the table
     * @param {Object} options - {data: Object, select?: Object}
     * @returns {Promise<Object>} Created record
     */
    async create({ data, select }) {
      const cols = Object.keys(data);
      const sql = `INSERT INTO ${qTable} (${cols.map(quote).join(", ")}) VALUES (${cols.map(c => `:${c}`).join(", ")}) RETURNING *;`;

      const res = await executeSQL(baseUrls, port, sql, data, auth);
      const r = res.results?.[0] || {};

      if (r.values?.length > 0) {
        const obj = {};
        r.columns.forEach((c, i) => obj[c] = r.values[0][i]);

        // Apply select filter if provided
        if (select) {
          return Object.fromEntries(
            Object.keys(select).filter(k => select[k]).map(k => [k, obj[k]])
          );
        }
        return obj;
      }

      return data;
    },

    /**
     * Finds multiple records matching the filter
     * @param {Object} options - {where?, select?, orderBy?, limit?, offset?, level?}
     * @returns {Promise<Object[]>} Array of matching records
     */
    async findMany({ where, select, orderBy, limit, offset, level } = {}) {
      const { clause, params } = buildWhere(where, fields);
      const sel = buildSelect(select, fields);

      let sql = `SELECT ${sel} FROM ${qTable} WHERE ${clause}`;

      // Add ORDER BY if specified
      if (orderBy) {
        const orders = (Array.isArray(orderBy) ? orderBy : [orderBy]).map(o => {
          const [col, dir] = Object.entries(o)[0];
          const d = dir.toUpperCase();
          if (d !== "ASC" && d !== "DESC") {
            throw new Error("Invalid order direction. Use 'ASC' or 'DESC'.");
          }
          return `${quote(col)} ${d}`;
        });
        sql += ` ORDER BY ${orders.join(", ")}`;
      }

      // Add LIMIT with validation
      if (limit !== undefined) {
        if (!Number.isInteger(limit) || limit < 0) {
          throw new Error("Invalid limit. Must be a non-negative integer.");
        }
        sql += ` LIMIT ${limit}`;
      }

      // Add OFFSET with validation
      if (offset !== undefined) {
        if (!Number.isInteger(offset) || offset < 0) {
          throw new Error("Invalid offset. Must be a non-negative integer.");
        }
        sql += ` OFFSET ${offset}`;
      }

      return await querySQL(baseUrls, port, sql, params, auth, level);
    },

    /**
     * Finds a single unique record
     * @param {Object} args - Same as findMany
     * @returns {Promise<Object|null>} Matching record or null
     */
    async findUnique(args) {
      return (await this.findMany({ ...args, limit: 1 }))[0] || null;
    },

    /**
     * Finds the first matching record
     * @param {Object} args - Same as findMany
     * @returns {Promise<Object|null>} First matching record or null
     */
    async findFirst(args) {
      return (await this.findMany({ ...args, limit: 1 }))[0] || null;
    },

    /**
     * Updates records matching the filter
     * Supports increment and math operations
     * @param {Object} options - {where: Object, data: Object, select?: Object}
     * @returns {Promise<Object|null>} Updated record or null
     */
    async update({ where, data, select }) {
      const { clause, params } = buildWhere(where, fields);
      const sets = [];
      let mIdx = 0;

      for (const [c, val] of Object.entries(data)) {
        const qCol = quote(c);

        if (val && typeof val === "object") {
          // Handle increment operation
          if (val.increment !== undefined) {
            params[`d_${c}`] = val.increment;
            sets.push(`${qCol} = ${qCol} + :d_${c}`);
          }
          // Handle math expression
          else if (val.math !== undefined) {
            // Validate math expression for safety
            if (!validateMathExpression(val.math)) {
              throw new Error("Unsafe math expression detected. Operation blocked.");
            }

            let expr = val.math;

            // Replace argument placeholders with unique param names
            if (val.args) {
              for (const [ak, av] of Object.entries(val.args)) {
                const pName = `m_${c}_${mIdx++}`;
                expr = expr.replace(new RegExp(`:${ak}\\b`, 'g'), `:${pName}`);
                params[pName] = av;
              }
            }

            sets.push(`${qCol} = ${expr}`);
          }
        } else {
          // Simple value assignment
          params[`d_${c}`] = val;
          sets.push(`${qCol} = :d_${c}`);
        }
      }

      const res = await executeSQL(
        baseUrls,
        port,
        `UPDATE ${qTable} SET ${sets.join(", ")} WHERE ${clause} RETURNING *;`,
        params,
        auth
      );

      const r = res.results?.[0] || {};

      if (r.values?.length > 0) {
        const obj = {};
        r.columns.forEach((col, i) => obj[col] = r.values[0][i]);

        // Apply select filter if provided
        return select
          ? Object.fromEntries(Object.keys(select).filter(k => select[k]).map(k => [k, obj[k]]))
          : obj;
      }

      return null;
    },

    /**
     * Deletes records matching the filter
     * @param {Object} options - {where: Object}
     * @returns {Promise<boolean>} True on success
     */
    async delete({ where }) {
      const { clause, params } = buildWhere(where, fields);
      await executeSQL(baseUrls, port, `DELETE FROM ${qTable} WHERE ${clause};`, params, auth);
      return true;
    },

    /**
     * Counts records matching the filter
     * @param {Object} options - {where?, level?}
     * @returns {Promise<number>} Count of matching records
     */
    async count({ where, level } = {}) {
      const { clause, params } = buildWhere(where, fields);
      const res = await querySQL(
        baseUrls,
        port,
        `SELECT COUNT(1) AS c FROM ${qTable} WHERE ${clause};`,
        params,
        auth,
        level
      );
      return Number(res[0]?.c || 0);
    }
  };
}

// ============================================================================
// BATCH BUILDER
// ============================================================================

/**
 * Creates a batch builder for executing multiple operations atomically
 * Groups operations by server for efficient transaction execution
 * @param {Object} schemaDef - Complete schema definition
 * @returns {Object} Batch builder with table-specific methods and execute()
 */
function createBatchBuilder(schemaDef) {
  const operations = [];

  const builder = {
    /**
     * Executes all queued batch operations
     * Groups operations by server and runs as transactions
     * @returns {Promise<Object>} Results grouped by server key
     */
    async execute() {
      // Group operations by server (port + baseUrls combination)
      const groups = {};

      for (const op of operations) {
        const key = `${op.port}|${JSON.stringify(op.baseUrls)}`;
        if (!groups[key]) {
          groups[key] = { ...op, ops: [] };
        }
        groups[key].ops.push([op.sql, op.params]);
      }

      const results = {};

      try {
        // Execute each group as a transaction
        for (const [key, g] of Object.entries(groups)) {
          results[key] = await rqliteRequest(
            g.baseUrls,
            g.port,
            "/db/execute?transaction&named_parameters",
            g.ops,
            g.auth
          );
        }
        return results;
      } finally {
        // Always clear operations after execution to prevent memory leaks
        operations.length = 0;
      }
    }
  };

  // Add table-specific batch methods
  for (const [tName, cfg] of Object.entries(schemaDef)) {
    const baseUrls = sortBaseUrls(cfg.config.base);
    const { port, username, password } = cfg.config;
    const auth = (username && password) ? { username, password } : null;
    const fields = Object.keys(cfg.fields);
    const qTable = quote(tName);

    builder[tName] = {
      /**
       * Queues a create operation
       * @param {Object} options - {data: Object}
       * @returns {Object} The batch builder for chaining
       */
      create({ data }) {
        const cols = Object.keys(data);
        const sql = `INSERT INTO ${qTable} (${cols.map(quote).join(", ")}) VALUES (${cols.map(c => `:${c}`).join(", ")});`;
        operations.push({ baseUrls, port, sql, params: data, auth });
        return builder;
      },

      /**
       * Queues an update operation
       * @param {Object} options - {where: Object, data: Object}
       * @returns {Object} The batch builder for chaining
       */
      update({ where, data }) {
        const { clause, params } = buildWhere(where, fields);
        const sets = [];
        let mIdx = 0;

        for (const [c, val] of Object.entries(data)) {
          const qCol = quote(c);

          if (val && typeof val === "object") {
            if (val.increment !== undefined) {
              params[`d_${c}`] = val.increment;
              sets.push(`${qCol} = ${qCol} + :d_${c}`);
            } else if (val.math !== undefined) {
              // Validate math expression for safety
              if (!validateMathExpression(val.math)) {
                throw new Error("Unsafe math expression detected. Operation blocked.");
              }

              let expr = val.math;
              if (val.args) {
                for (const [ak, av] of Object.entries(val.args)) {
                  const pName = `m_${c}_${mIdx++}`;
                  expr = expr.replace(new RegExp(`:${ak}\\b`, 'g'), `:${pName}`);
                  params[pName] = av;
                }
              }
              sets.push(`${qCol} = ${expr}`);
            }
          } else {
            params[`d_${c}`] = val;
            sets.push(`${qCol} = :d_${c}`);
          }
        }

        operations.push({
          baseUrls,
          port,
          sql: `UPDATE ${qTable} SET ${sets.join(", ")} WHERE ${clause};`,
          params,
          auth
        });
        return builder;
      },

      /**
       * Queues a delete operation
       * @param {Object} options - {where: Object}
       * @returns {Object} The batch builder for chaining
       */
      delete({ where }) {
        const { clause, params } = buildWhere(where, fields);
        operations.push({
          baseUrls,
          port,
          sql: `DELETE FROM ${qTable} WHERE ${clause};`,
          params,
          auth
        });
        return builder;
      }
    };
  }

  return builder;
}

// ============================================================================
// SCHEMA DDL HELPERS
// ============================================================================

/**
 * Generates SQL column definition for CREATE TABLE or ALTER TABLE
 * @param {string} name - Column name
 * @param {Object} def - Column definition from schema
 * @returns {string} SQL column definition
 */
function columnDefSQL(name, def) {
  const parts = [quote(name), def.type.toUpperCase()];

  if (def.pk) parts.push("PRIMARY KEY");
  if (def.autoIncrement) parts.push("AUTOINCREMENT");
  if (def.notNull) parts.push("NOT NULL");

  // Handle default values with safety checks
  if (def.default !== undefined) {
    const val = def.default;

    if (typeof val === "string") {
      // Check if it's a SQL keyword (like CURRENT_TIMESTAMP)
      if (/^[A-Z_]+$/.test(val)) {
        parts.push(`DEFAULT ${val}`);
      } else {
        // Escape string literals properly
        parts.push(`DEFAULT '${val.replace(/'/g, "''")}'`);
      }
    } else if (typeof val === "number" || typeof val === "boolean") {
      parts.push(`DEFAULT ${val}`);
    }
  }

  return parts.join(" ");
}

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

/**
 * Initializes database schema - creates tables and adds missing columns
 * Performs safe migrations without data loss
 * @param {Object} schemaDef - Complete schema definition
 * @param {boolean} verbose - Enable verbose logging
 * @returns {Promise<boolean>} True on success
 */
async function initDBSchema(schemaDef, verbose = false) {
  if (verbose) CONFIG.verbose = true;

  // Validate entire schema before making any changes
  validateSchema(schemaDef);

  for (const [tName, cfg] of Object.entries(schemaDef)) {
    const sorted = sortBaseUrls(cfg.config.base);
    const { port, username, password } = cfg.config;
    const auth = (username && password) ? { username, password } : null;

    // Generate column definitions
    const colDefs = Object.entries(cfg.fields).map(([c, d]) => columnDefSQL(c, d));

    // Create table if not exists (only on first URL - the leader)
    await executeSQL(
      [sorted[0]],
      port,
      `CREATE TABLE IF NOT EXISTS ${quote(tName)} (${colDefs.join(", ")});`,
      {},
      auth
    );

    // Check for missing columns using cache
    const cacheKey = `${tName}|${port}`;
    let info = getCachedSchema(cacheKey);

    if (!info) {
      info = await querySQL([sorted[0]], port, `PRAGMA table_info(${quote(tName)})`, {}, auth, "strong");
      setCachedSchema(cacheKey, info);
    }

    const existing = new Set(info.map(r => r.name));

    // Add any missing columns (safe migration)
    for (const [cName, cDef] of Object.entries(cfg.fields)) {
      if (!existing.has(cName)) {
        await executeSQL(
          [sorted[0]],
          port,
          `ALTER TABLE ${quote(tName)} ADD COLUMN ${columnDefSQL(cName, cDef)};`,
          {},
          auth
        );
        // Invalidate cache after schema change
        invalidateCache(cacheKey);
      }
    }

    // Create indexes if specified
    if (cfg.indexes) {
      for (const idx of cfg.indexes) {
        const name = quote(idx.name || `idx_${tName}_${idx.columns.join("_")}`);
        await executeSQL(
          [sorted[0]],
          port,
          `CREATE ${idx.unique ? "UNIQUE" : ""} INDEX IF NOT EXISTS ${name} ON ${quote(tName)} (${idx.columns.map(quote).join(", ")});`,
          {},
          auth
        );
      }
    }
  }

  return true;
}

// ============================================================================
// CLIENT FACTORY
// ============================================================================

/**
 * Creates a new rqlink client for the given schema
 * @param {Object} schemaDef - Complete schema definition
 * @returns {Object} Client with {db, initDB, dropDB} methods
 * @example
 * const { db, initDB, dropDB } = createClient(schema);
 * await initDB();
 * const user = await db.users.create({ data: { name: "Alice" } });
 */
export function createClient(schemaDef) {
  // Validate schema on client creation
  validateSchema(schemaDef);

  // Build database model with table-specific methods
  const db = {
    batch: {
      start: () => createBatchBuilder(schemaDef)
    }
  };

  // Add model for each table
  for (const t of Object.keys(schemaDef)) {
    db[t] = buildModel(t, schemaDef[t]);
  }

  return {
    db,

    /**
     * Initializes the database schema
     * @param {Object} opts - {verbose?: boolean}
     * @returns {Promise<boolean>} True on success
     */
    initDB: (opts = {}) => initDBSchema(schemaDef, opts.verbose),

    /**
     * Drops all tables in the schema
     * WARNING: This will delete all data
     * @returns {Promise<void>}
     */
    dropDB: async () => {
      for (const [t, cfg] of Object.entries(schemaDef)) {
        const auth = (cfg.config.username && cfg.config.password)
          ? { username: cfg.config.username, password: cfg.config.password }
          : null;

        await executeSQL(
          [sortBaseUrls(cfg.config.base)[0]],
          cfg.config.port,
          `DROP TABLE IF EXISTS ${quote(t)};`,
          {},
          auth
        );

        // Clear cache entry for dropped table
        invalidateCache(`${t}|${cfg.config.port}`);
      }
    }
  };
}

// ============================================================================
// DEFAULT EXPORT
// ============================================================================

export default { configure, createClient, executeSQL, querySQL };