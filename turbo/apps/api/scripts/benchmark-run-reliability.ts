import { writeFile } from "node:fs/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { Client } from "pg";

const RELIABILITY_QUERY = `
  SELECT
    org_id AS "orgId",
    user_id AS "userId",
    COUNT(*)::int AS "totalRuns",
    COUNT(*) FILTER (WHERE status = 'completed')::int AS "successfulRuns",
    COUNT(*) FILTER (WHERE status = 'failed')::int AS "failedRuns",
    COUNT(*) FILTER (WHERE status = 'cancelled')::int AS "cancelledRuns",
    COUNT(*) FILTER (WHERE status = 'timeout')::int AS "timedOutRuns",
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)) * 1000
    ) FILTER (WHERE started_at IS NOT NULL AND started_at >= created_at) AS "queueP50Ms",
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (started_at - created_at)) * 1000
    ) FILTER (WHERE started_at IS NOT NULL AND started_at >= created_at) AS "queueP95Ms",
    PERCENTILE_CONT(0.5) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
    ) FILTER (WHERE started_at IS NOT NULL AND completed_at >= started_at) AS "runtimeP50Ms",
    PERCENTILE_CONT(0.95) WITHIN GROUP (
      ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
    ) FILTER (WHERE started_at IS NOT NULL AND completed_at >= started_at) AS "runtimeP95Ms"
  FROM reliability_benchmark_runs
  WHERE org_id = ANY($1::text[])
    AND user_id = ANY($2::text[])
    AND completed_at >= $3::timestamp
    AND completed_at < $4::timestamp
    AND completed_at IS NOT NULL
  GROUP BY org_id, user_id
`;

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function percentile(samples: readonly number[], quantile: number): number {
  const ordered = [...samples].sort((left, right) => {
    return left - right;
  });
  const index = Math.round((ordered.length - 1) * quantile);
  return ordered[index] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

function collectPlanNodes(plan: Record<string, unknown>): string[] {
  const current = String(plan["Node Type"] ?? "unknown");
  const indexName = plan["Index Name"]
    ? ` (${String(plan["Index Name"])})`
    : "";
  const children = Array.isArray(plan.Plans)
    ? plan.Plans.flatMap((child) => {
        return collectPlanNodes(child as Record<string, unknown>);
      })
    : [];
  return [`${current}${indexName}`, ...children];
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }
  const rowCount = Number(argument("--rows", "200000"));
  const repeats = Number(argument("--repeats", "7"));
  const output = argument("--output");
  if (
    !Number.isInteger(rowCount) ||
    rowCount < 1 ||
    !Number.isInteger(repeats) ||
    repeats < 1
  ) {
    throw new Error("--rows and --repeats must be positive integers");
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`
      CREATE TEMP TABLE reliability_benchmark_runs (
        org_id text NOT NULL,
        user_id text NOT NULL,
        status text NOT NULL,
        created_at timestamp NOT NULL,
        started_at timestamp,
        completed_at timestamp
      ) ON COMMIT PRESERVE ROWS
    `);
    await client.query(
      `
        INSERT INTO reliability_benchmark_runs
        SELECT
          'org-' || (series % 20),
          'user-' || (series % 200),
          (ARRAY['completed', 'failed', 'cancelled', 'timeout'])[(series % 4) + 1],
          timestamp '2026-01-01 00:00:00'
            + ((series % (30 * 86400)) * interval '1 second'),
          timestamp '2026-01-01 00:00:00'
            + ((series % (30 * 86400)) * interval '1 second')
            + ((series % 8000) * interval '1 millisecond'),
          timestamp '2026-01-01 00:00:00'
            + ((series % (30 * 86400)) * interval '1 second')
            + ((series % 8000) * interval '1 millisecond')
            + ((10000 + series % 120000) * interval '1 millisecond')
        FROM generate_series(1, $1::int) AS series
      `,
      [rowCount],
    );
    await client.query(`
      CREATE INDEX reliability_benchmark_completed_org_user
      ON reliability_benchmark_runs (completed_at DESC, org_id, user_id)
      WHERE completed_at IS NOT NULL
    `);
    await client.query("ANALYZE reliability_benchmark_runs");

    const orgIds = Array.from({ length: 20 }, (_, index) => {
      return `org-${index}`;
    });
    const userIds = Array.from({ length: 200 }, (_, index) => {
      return `user-${index}`;
    });
    const parameters = [orgIds, userIds, "2026-01-02", "2026-01-03"];
    await client.query(RELIABILITY_QUERY, parameters);

    const durations: number[] = [];
    let groupCount = 0;
    let matchedRuns = 0;
    for (let index = 0; index < repeats; index += 1) {
      const started = performance.now();
      const result = await client.query(RELIABILITY_QUERY, parameters);
      durations.push(performance.now() - started);
      groupCount = result.rowCount ?? 0;
      matchedRuns = result.rows.reduce((total, row) => {
        return total + Number(row.totalRuns);
      }, 0);
    }

    const explained = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${RELIABILITY_QUERY}`,
      parameters,
    );
    const explanation = explained.rows[0]["QUERY PLAN"][0] as Record<
      string,
      unknown
    >;
    const plan = explanation.Plan as Record<string, unknown>;
    const result = {
      benchmark: "daily-run-reliability-aggregation",
      environment: {
        node: process.version,
        platform: `${os.platform()} ${os.release()} ${os.arch()}`,
        postgres: (await client.query("SHOW server_version")).rows[0]
          .server_version,
      },
      configuration: {
        syntheticRows: rowCount,
        matchedRuns,
        groups: groupCount,
        repeats,
        timeWindow: "2026-01-02T00:00:00Z/2026-01-03T00:00:00Z",
      },
      clientLatencyMs: {
        median: round(percentile(durations, 0.5)),
        p95: round(percentile(durations, 0.95)),
        samples: durations.map(round),
      },
      explainAnalyze: {
        planningTimeMs: round(Number(explanation["Planning Time"])),
        executionTimeMs: round(Number(explanation["Execution Time"])),
        planNodes: collectPlanNodes(plan),
      },
      scope:
        "Local synthetic PostgreSQL benchmark; not a production traffic claim.",
    };
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    if (output) {
      const outputPath = path.resolve(output);
      await writeFile(outputPath, rendered, "utf8");
    }
    process.stdout.write(rendered);
  } finally {
    await client.end();
  }
}

await main();
