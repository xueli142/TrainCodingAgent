#!/usr/bin/env node
import { spawn } from "node:child_process";

const sub = process.argv[2];

if (sub === "start") {
  const child = spawn("pnpm", ["start"], { stdio: "inherit", shell: true });
  child.on("exit", (code) => process.exit(code));
} else {
  console.log(`未知命令: ${sub ?? "(空)"}`);
  console.log("用法: icefox start");
  process.exit(1);
}