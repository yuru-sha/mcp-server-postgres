#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Pool, PoolClient } from "pg";

const server = new Server(
  {
    name: "mcp-server-postgres",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Please provide a database URL as a command-line argument");
  process.exit(1);
}

const databaseUrl = args[0];

const resourceBaseUrl = new URL(databaseUrl);
resourceBaseUrl.protocol = "postgres:";
resourceBaseUrl.password = "";

const pool = new Pool({
  connectionString: databaseUrl,
});

const SCHEMA_PATH = "schema";

// 禁止されたSQLキーワードのリスト
const FORBIDDEN_KEYWORDS = [
  // DDL
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  // DCL
  "GRANT",
  "REVOKE",
  // TCL
  "BEGIN",
  "START TRANSACTION",
  "COMMIT",
  "ROLLBACK",
  "SAVEPOINT",
  // DML
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "UPSERT",
  // その他の危険な操作
  "SET",
  "RESET",
  "LOCK",
  "UNLOCK",
  "VACUUM",
  "CLUSTER",
  "REINDEX",
  "ANALYZE",
  "EXPLAIN",
  "EXECUTE",
  "PREPARE",
  "DEALLOCATE",
  "DECLARE",
  "FETCH",
  "MOVE",
  "CLOSE",
  "LISTEN",
  "NOTIFY",
  "LOAD",
  "COPY",
];

// トランザクションを開始し、READ ONLYモードを設定する関数
async function beginReadOnlyTransaction(client: PoolClient): Promise<void> {
  await client.query("BEGIN");
  await client.query("SET TRANSACTION READ ONLY");
  // セッションレベルでも読み取り専用に設定
  await client.query("SET default_transaction_read_only = on");
  await client.query("SET statement_timeout = 5000"); // 5秒でタイムアウト
}

// SQLクエリが安全かどうかをチェックする関数
function isQuerySafe(sql: string): boolean {
  const normalizedSql = sql.toUpperCase().replace(/\s+/g, " ").trim();

  // SELECTで始まることを確認
  if (!normalizedSql.startsWith("SELECT ")) {
    return false;
  }

  // 禁止キーワードのチェック
  return !FORBIDDEN_KEYWORDS.some((keyword) => {
    const pattern = new RegExp(`(^|\\s)${keyword}(\\s|$)`);
    return pattern.test(normalizedSql);
  });
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const client = await pool.connect();
  try {
    await beginReadOnlyTransaction(client);
    const { rows } = await client.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    await client.query("COMMIT");
    return {
      resources: rows.map((row) => ({
        uri: new URL(`${row.table_name}/${SCHEMA_PATH}`, resourceBaseUrl).href,
        mimeType: "application/json",
        name: `"${row.table_name}" database schema`,
      })),
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const resourceUrl = new URL(request.params.uri);

  const pathComponents = resourceUrl.pathname.split("/");
  const schema = pathComponents.pop();
  const tableName = pathComponents.pop();

  if (schema !== SCHEMA_PATH) {
    throw new Error("Invalid resource URI");
  }

  const client = await pool.connect();
  try {
    await beginReadOnlyTransaction(client);
    const { rows } = await client.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 AND table_schema = 'public'",
      [tableName]
    );
    await client.query("COMMIT");
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(rows, null, 2),
        },
      ],
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "query",
        description: "Run a read-only SQL query",
        inputSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "query") {
    const sql = request.params.arguments?.sql as string;

    if (!isQuerySafe(sql)) {
      throw new Error(
        "Only simple SELECT queries are allowed for security reasons"
      );
    }

    const client = await pool.connect();
    try {
      await beginReadOnlyTransaction(client);
      const { rows } = await client.query(sql);
      await client.query("COMMIT");
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
        isError: false,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error(`Unknown tool: ${request.params.name}`);
});

async function runServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

process.on("exit", () => {
  pool.end();
});

runServer().catch(console.error);
