#!/usr/bin/env node
// Fills in the "pure C++" op-sqlite architecture (a TurboModule used only as
// an install() entry point into hand-written JSI) inside an EXISTING
// react-native-builder-bob / create-react-native-library turbo-module
// project. This does not scaffold a new npm package — run
// `npx create-react-native-library@latest <name> --type turbo-module
// --languages kotlin-objc` first, then run this inside that directory.
//
// Usage:
//   node generate.mjs --prefix Acme --package com.acme.kit [--dir .]
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

function normalizeAuthor(author) {
  if (!author) return "";
  if (typeof author === "string") return author;
  const parts = [author.name, author.email && `<${author.email}>`, author.url && `(${author.url})`];
  return parts.filter(Boolean).join(" ");
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

function replaceTokens(content, tokens) {
  let result = content;
  for (const [token, value] of Object.entries(tokens)) {
    result = result.split(token).join(value);
  }
  return result;
}

// Detects a react-native-builder-bob / create-react-native-library
// turbo-module project: the only kind of project this skill knows how to
// operate on.
function detectBuilderBobProject(dir) {
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const isBobProject = Boolean(pkg["react-native-builder-bob"] || pkg["create-react-native-library"]);
  return isBobProject ? pkg : null;
}

// Removes leftover files from the library's default example TurboModule
// (e.g. create-react-native-library's "Multiply" boilerplate) that this
// skill's entry point supersedes but doesn't share a filename with.
function cleanupStaleFiles(outDir, { prefix, javaPackagePath, oldJavaPackagePath }) {
  const removed = [];

  const removeIfNotIn = (dir, keepNames) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || keepNames.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      fs.rmSync(full);
      removed.push(path.relative(outDir, full));
    }
  };

  removeIfNotIn(path.join(outDir, "src"), new Set([`Native${prefix}.ts`, "index.ts"]));
  removeIfNotIn(path.join(outDir, "ios"), new Set([`${prefix}.h`, `${prefix}.mm`]));

  // Covers leftovers from create-react-native-library's other native-code
  // templates too (e.g. its "cpp" turbo-module type, which generates
  // cpp/{Name}Impl.h/.cpp implementing a fully codegen'd Cxx spec — an
  // architecture this skill replaces entirely).
  const cppKeep = new Set([
    `${prefix}Module.cpp`,
    `${prefix}Module.hpp`,
    `${prefix}ThreadPool.cpp`,
    `${prefix}ThreadPool.hpp`,
    "ExampleHostObject.cpp",
    "ExampleHostObject.hpp",
    "logs.h",
    "macros.hpp",
    `${prefix}Types.hpp`,
    `${prefix}Utils.hpp`,
    `${prefix}Utils.cpp`,
  ]);
  removeIfNotIn(path.join(outDir, "cpp"), cppKeep);

  const kotlinKeep = new Set([`${prefix}Bridge.kt`, `${prefix}Module.kt`, `${prefix}Package.kt`]);
  removeIfNotIn(path.join(outDir, "android", "src", "main", "java", javaPackagePath), kotlinKeep);

  if (oldJavaPackagePath && oldJavaPackagePath !== javaPackagePath) {
    const oldDir = path.join(outDir, "android", "src", "main", "java", oldJavaPackagePath);
    removeIfNotIn(oldDir, new Set());
    // Prune now-empty package directories left behind by the old path, up to
    // (but not including) android/src/main/java itself.
    let dir = oldDir;
    const stopAt = path.join(outDir, "android", "src", "main", "java");
    while (dir !== stopAt && dir.startsWith(stopAt) && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }

  // create-react-native-library's "cpp" turbo-module type writes a root
  // react-native.config.js declaring cxxModuleCMakeListsPath/cxxModuleHeaderName
  // (pointing at a build-generated android/generated/jni that only exists for
  // the fully codegen'd Cxx architecture). Leaving it in place makes RN's
  // autolinking try to add_subdirectory a path this skill's hand-written JNI
  // bridge never produces, breaking the Android CMake configure step.
  const staleConfigPath = path.join(outDir, "react-native.config.js");
  if (fs.existsSync(staleConfigPath)) {
    fs.rmSync(staleConfigPath);
    removed.push(path.relative(outDir, staleConfigPath));
  }

  return removed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const outDir = path.resolve(process.cwd(), args.dir || ".");

  const pkg = detectBuilderBobProject(outDir);
  if (!pkg && !args.force) {
    throw new Error(
      `"${outDir}" doesn't look like a react-native-builder-bob / create-react-native-library project ` +
        `(no package.json, or missing a "react-native-builder-bob"/"create-react-native-library" key).\n\n` +
        `This skill fills in the pure-C++ JSI entry point inside an EXISTING turbo-module library scaffold — it ` +
        `doesn't create a new npm package from scratch. First run:\n\n` +
        `  npx create-react-native-library@latest <name> --type turbo-module --languages kotlin-objc\n\n` +
        `then re-run this generator from inside that directory (pass --force to bypass this check).`
    );
  }

  const name = pkg?.name ?? path.basename(outDir);
  const kebabName = kebabFromPackageName(name);
  const description = pkg?.description ?? "";
  const author = normalizeAuthor(pkg?.author);
  const oldJavaPackage = pkg?.codegenConfig?.android?.javaPackageName;

  const prefixRaw = await ensure(args, "prefix", "Short PascalCase prefix (e.g. Acme): ");
  const defaultJavaPackage = oldJavaPackage || `com.${kebabName.replace(/-/g, "")}`;
  const javaPackage = await ensure(args, "package", `Java package [${defaultJavaPackage}]: `, defaultJavaPackage);

  if (!/^[A-Za-z][A-Za-z0-9]{2,}$/.test(prefixRaw)) {
    throw new Error(`Prefix "${prefixRaw}" must be alphanumeric, start with a letter, and be at least 3 characters.`);
  }

  const prefix = toPascalCase(prefixRaw); // e.g. Acme
  const prefixUpper = prefix.toUpperCase(); // ACME
  const prefixLower = prefix.toLowerCase(); // acme
  const podName = kebabName; // must match the pod/library identity create-react-native-library already created
  const javaPackagePath = javaPackage.split(".").join("/");
  const oldJavaPackagePath = oldJavaPackage ? oldJavaPackage.split(".").join("/") : null;

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

  const removed = cleanupStaleFiles(outDir, { prefix, javaPackagePath, oldJavaPackagePath });

  const pkgPath = path.join(outDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    const currentPkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    currentPkg.codegenConfig = {
      ...currentPkg.codegenConfig,
      name: currentPkg.codegenConfig?.name || `${prefix}Spec`,
      type: "modules",
      jsSrcsDir: currentPkg.codegenConfig?.jsSrcsDir || "src",
      android: { ...currentPkg.codegenConfig?.android, javaPackageName: javaPackage },
    };
    fs.writeFileSync(pkgPath, JSON.stringify(currentPkg, null, 2) + "\n", "utf8");
  }

  console.log(`\nWrote ${written.length} files into ${outDir}:\n`);
  for (const f of written.sort()) {
    console.log(`  ${f}`);
  }

  if (removed.length > 0) {
    console.log(`\nRemoved ${removed.length} superseded file(s) from the default example module:\n`);
    for (const f of removed.sort()) {
      console.log(`  ${f}`);
    }
  }

  console.log(`\nPrefix: ${prefix}  |  Namespace: ${prefixLower}  |  Java package: ${javaPackage}  |  Pod name: ${podName}`);
  console.log(`Next: yarn install (if package.json's codegenConfig changed) && cd example && yarn pods (or equivalent) to rebuild.`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
