#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const forbiddenTerms = [
  "Sied" + "le",
  "sied" + "le" + "group",
  "kaya" + "hk",
  "Ha" + "kan",
  "sg" + "c",
  "Hol" + "mes",
  "376" + "9565",
  "134" + "261327"
];
const forbidden = new RegExp(forbiddenTerms.join("|"), "i");
const credential =
  /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----/;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const violations = [];
for (const file of files) {
  if (forbidden.test(file)) {
    violations.push(`${file}: forbidden identifier in filename`);
    continue;
  }

  const body = readFileSync(file);
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  if (forbidden.test(text)) violations.push(`${file}: forbidden identifier`);
  if (credential.test(text)) violations.push(`${file}: credential material`);
}

if (violations.length > 0) {
  console.error("Public-safety scan failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Public-safety scan passed (${files.length} tracked files).`);
