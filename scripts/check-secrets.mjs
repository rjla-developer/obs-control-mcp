#!/usr/bin/env node
// Refuses to let secrets or personal data into this public repository.
//
// Scans every file git would commit (tracked + untracked-but-not-ignored) for
// IP addresses, home-directory paths, e-mail addresses, private keys and
// common token formats. Extra literal strings (your own LAN address, user
// name, hostnames) can be listed one per line in `.forbidden-strings`, which
// is git-ignored, or in the SECRET_SCAN_EXTRA environment variable
// (comma-separated). Exit code 1 when something is found.
//
// Usage: node scripts/check-secrets.mjs [--staged] [root]

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
const ALLOWED_IP = /^(127\.0\.0\.1|0\.0\.0\.0|255\.255\.255\.255|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const HOME = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+)(?!(?:example|runner|you|USER|USERNAME|me|name)\b)[A-Za-z0-9._-]+/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /(@example\.(com|org|net)|noreply\.github\.com|^noreply@anthropic\.com)$/i;
const TOKENS = [
  ["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["Anthropic/OpenAI key", /\bsk-(ant-)?[A-Za-z0-9_-]{24,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["Private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["Twitch/RTMP stream key", /\blive_[0-9]{6,}_[A-Za-z0-9]{20,}\b/g],
];
const SKIP = [/^package-lock\.json$/, /^node_modules\//, /^dist\//, /\.(png|jpg|jpeg|gif|ico|woff2?)$/i];

export function scanText(text, extra = []) {
  const findings = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const at = (kind, match) => findings.push({ line: i + 1, kind, match });
    for (const m of line.matchAll(IPV4)) {
      const parts = m[0].split(".").map(Number);
      if (parts.every((p) => p <= 255) && !ALLOWED_IP.test(m[0])) at("IP address", m[0]);
    }
    for (const m of line.matchAll(HOME)) at("home directory path", m[0]);
    for (const m of line.matchAll(EMAIL)) if (!ALLOWED_EMAIL.test(m[0])) at("e-mail address", m[0]);
    for (const [kind, re] of TOKENS) for (const m of line.matchAll(re)) at(kind, m[0]);
    for (const s of extra) if (s && line.includes(s)) at("forbidden string", s);
  });
  return findings;
}

function listFiles(root, staged) {
  try {
    const args = staged
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
      : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function readStaged(root, file) {
  return execFileSync("git", ["show", `:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function loadExtra(root) {
  const extra = (process.env.SECRET_SCAN_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const f = join(root, ".forbidden-strings");
  if (existsSync(f)) {
    for (const l of readFileSync(f, "utf8").split("\n")) {
      const s = l.trim();
      if (s && !s.startsWith("#")) extra.push(s);
    }
  }
  return extra;
}

export function scanRepo(root, { staged = false } = {}) {
  const extra = loadExtra(root);
  const results = [];
  for (const file of listFiles(root, staged)) {
    if (SKIP.some((re) => re.test(file)) || file === ".forbidden-strings") continue;
    let text;
    try {
      if (staged) text = readStaged(root, file);
      else {
        const p = join(root, file);
        if (!existsSync(p) || statSync(p).size > 5 * 1024 * 1024) continue;
        text = readFileSync(p, "utf8");
      }
    } catch {
      continue;
    }
    for (const f of scanText(text, extra)) results.push({ file, ...f });
  }
  return results;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("check-secrets.mjs")) {
  const args = process.argv.slice(2);
  const staged = args.includes("--staged");
  const root = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
  const found = scanRepo(root, { staged });
  if (found.length) {
    console.error("check-secrets: this repository is public; remove these before committing:");
    // Show where, and only a hint of what (the value itself may be the secret).
    for (const f of found) console.error(`  ${f.file}:${f.line}  ${f.kind}  (${f.match.slice(0, 4)}…)`);
    process.exit(1);
  }
  console.error("check-secrets: clean");
}
