#!/usr/bin/env node
// Scaffolds a new "pure C++" React Native module (op-sqlite architecture:
// TurboModule used only as an install() entry point into hand-written JSI).
//
// Usage:
//   node generate.mjs --name react-native-acme-kit --prefix Acme \
//     --package com.acme.kit --dir ../react-native-acme-kit \
//     --description "Acme kit for React Native" --author "Jane Doe"
//
// All flags can also be supplied interactively if omitted and stdin is a TTY.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, "..", "templates");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      args.force = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Missing value for --${key}`);
      }
      args[key] = value;
      i++;
    }
  }
  return args;
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

async function ensure(args, key, question, fallback) {
  if (args[key]) return args[key];
  if (!process.stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required --${key} (no TTY to prompt)`);
  }
  const answer = await prompt(question);
  return answer || fallback;
}

function toPascalCase(str) {
  return str
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

function kebabFromPackageName(name) {
  // Strip npm scope (@acme/foo -> foo), then kebab-case.
  const unscoped = name.includes("/") ? name.split("/")[1] : name;
  return unscoped
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function isDirEmpty(dir) {
  if (!fs.existsSync(dir)) return true;
  return fs.readdirSync(dir).length === 0;
}

function replaceTokens(content, tokens) {
  let result = content;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.split(token).join(value);
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const name = await ensure(args, "name", "npm package name (e.g. react-native-acme-kit): ");
  const prefixRaw = await ensure(args, "prefix", "Short PascalCase prefix (e.g. Acme): ");
  const javaPackage = await ensure(
    args,
    "package",
    "Java package (e.g. com.acme.kit): ",
    `com.${kebabFromPackageName(name).replace(/-/g, "")}`
  );
  const defaultDir = `./${kebabFromPackageName(name)}`;
  const outDir = path.resolve(process.cwd(), await ensure(args, "dir", `Output directory [${defaultDir}]: `, defaultDir));
  const description = await ensure(args, "description", "Description: ", `${name} React Native module`);
  const author = await ensure(args, "author", "Author: ", "");

  if (!/^[A-Za-z][A-Za-z0-9]{2,}$/.test(prefixRaw)) {
    throw new Error(`Prefix "${prefixRaw}" must be alphanumeric, start with a letter, and be at least 3 characters.`);
  }

  const prefix = toPascalCase(prefixRaw); // e.g. Acme
  const prefixUpper = prefix.toUpperCase(); // ACME
  const prefixLower = prefix.toLowerCase(); // acme
  const podName = prefix; // podspec/CMake package identifier
  const javaPackagePath = javaPackage.split(".").join("/");

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  } else if (!isDirEmpty(outDir) && !args.force) {
    throw new Error(
      `Output directory "${outDir}" already exists and is not empty. ` +
        `Pick a different --dir, or pass --force to write into it anyway.`
    );
  }

  const tokens = {
    __PACKAGE_NAME__: name,
    __DESCRIPTION__: description,
    __AUTHOR__: author,
    __POD_NAME__: podName,
    __PREFIX__: prefix,
    __PREFIX_UPPER__: prefixUpper,
    __PREFIX_LOWER__: prefixLower,
    __NAMESPACE__: prefixLower,
    __JAVA_PACKAGE__: javaPackage,
    __JAVA_PACKAGE_PATH__: javaPackagePath,
    // Composed directly (rather than written as "__" + __PREFIX__ + "Proxy"
    // in templates) because __PREFIX__ itself is a token whose match
    // consumes its own leading/trailing double underscores, which would eat
    // the literal "__" prefix we want to keep around the global name.
    __GLOBAL_PROXY__: `__${prefix}Proxy`,
  };

  const templateFiles = walk(TEMPLATES_DIR);
  const written = [];

  for (const srcFile of templateFiles) {
    const relFromTemplates = path.relative(TEMPLATES_DIR, srcFile);
    // Substitute tokens in the path itself (directory names and file names),
    // then strip the trailing .tmpl extension.
    let relOut = replaceTokens(relFromTemplates, tokens);
    if (relOut.endsWith(".tmpl")) {
      relOut = relOut.slice(0, -".tmpl".length);
    }

    const destFile = path.join(outDir, relOut);
    fs.mkdirSync(path.dirname(destFile), { recursive: true });

    const raw = fs.readFileSync(srcFile, "utf8");
    const content = replaceTokens(raw, tokens);
    fs.writeFileSync(destFile, content, "utf8");
    written.push(path.relative(outDir, destFile));
  }

  console.log(`\nScaffolded ${written.length} files into ${outDir}:\n`);
  for (const f of written.sort()) {
    console.log(`  ${f}`);
  }

  console.log(`\nPrefix: ${prefix}  |  Namespace: ${prefixLower}  |  Java package: ${javaPackage}`);
  console.log(`Next: cd ${path.relative(process.cwd(), outDir) || "."} && yarn install`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
