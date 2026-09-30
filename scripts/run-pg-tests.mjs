#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { availableParallelism } from "node:os";
import process from "node:process";
import { parseArgs } from "node:util";
import pg from "pg";

const { values, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    jobs: { type: "string", default: process.env.PG_TEST_JOBS ?? String(Math.min(4, availableParallelism())) },
    timeout: { type: "string", default: "600" },
  },
});

const jobs = Number(values.jobs);
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isInteger(jobs) || jobs < 1) throw new Error(`--jobs must be a positive integer, got ${values.jobs}`);
if (files.length === 0) throw new Error("Pass the Postgres test files to run");

const baseUrl = process.env.DATABASE_URL;
const runId = `qmt_${process.pid}_${randomBytes(4).toString("hex")}`;
const created = new Set();
const children = new Set();
const admin = baseUrl ? new pg.Pool({ connectionString: baseUrl, max: jobs }) : null;

function databaseUrl(name) {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function dropDatabase(name) {
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  created.delete(name);
}

function runFile(file, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", file], { env: { ...process.env, ...env } });
    children.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const timer = setTimeout(() => {
      output += `\n${file} exceeded ${values.timeout}s and was killed\n`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      resolve({ file, ok: code === 0 && !signal, ms: Date.now() - started, output });
    });
  });
}

async function runIsolated(file, index) {
  if (!admin) return runFile(file, {});
  const name = `${runId}_${index}`;
  await admin.query(`CREATE DATABASE ${name}`);
  created.add(name);
  try {
    return await runFile(file, { DATABASE_URL: databaseUrl(name) });
  } finally {
    await dropDatabase(name);
  }
}

async function cleanup() {
  for (const child of children) child.kill("SIGKILL");
  if (!admin) return;
  await Promise.allSettled([...created].map(dropDatabase));
  await admin.end();
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}

const started = Date.now();
const results = [];
let next = 0;
try {
  await Promise.all(
    Array.from({ length: Math.min(jobs, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        const result = await runIsolated(files[index], index);
        results.push(result);
        process.stdout.write(`\n# ${result.ok ? "ok" : "FAIL"} ${result.file} (${(result.ms / 1000).toFixed(1)}s)\n`);
        process.stdout.write(result.output);
      }
    }),
  );
} finally {
  await cleanup();
}

const failed = results.filter((result) => !result.ok);
const serialMs = results.reduce((sum, result) => sum + result.ms, 0);
process.stdout.write(
  `\n# ${results.length - failed.length}/${results.length} files passed with ${jobs} jobs in ${((Date.now() - started) / 1000).toFixed(1)}s (${(serialMs / 1000).toFixed(1)}s summed)\n`,
);
for (const result of failed) process.stdout.write(`# FAIL ${result.file}\n`);
process.exitCode = failed.length > 0 ? 1 : 0;
