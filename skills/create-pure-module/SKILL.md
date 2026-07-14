---
name: create-pure-module
description: Fill in the "pure C++" op-sqlite architecture — a TurboModule used only as a thin install() entry point that hands off to hand-written JSI HostObjects in C++ — inside an EXISTING react-native-builder-bob / create-react-native-library turbo-module project. Use when the user wants to replace a freshly-scaffolded RN turbo-module library's default codegen boilerplate with a fast, hand-written JSI API surface like op-sqlite, asks to "create a C++ RN module", "scaffold a JSI library", or references this skill by name.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(node *)
  - Bash(mkdir *)
  - Bash(ls *)
  - Bash(chmod *)
---

# create-pure-module

Fills in a react-native-builder-bob / create-react-native-library turbo-module
project with the **op-sqlite architecture**:

- The only real TurboModule method is a blocking-synchronous `install()` that
  hands the JSI `Runtime` and `CallInvoker` to hand-written C++. Codegen is
  used just to get that one call across the bridge cheaply.
- Everything else — the actual API surface — is plain JSI: `HostObject`s and
  `HostFunction`s built with helper macros, not codegen'd TurboModule specs.
  This avoids the serialization overhead and boilerplate of a "normal"
  TurboModule for every method.
- Async work follows one pattern everywhere: a per-HostObject `ThreadPool`
  runs the blocking work off the JS thread, and `CallInvoker::invokeAsync`
  jumps back onto the JS thread to resolve/reject the JS `Promise`. A
  `promisify()` helper wraps that boilerplate.
- Every generated identifier (C++ namespace, classes, files, Kotlin classes,
  JNI class descriptors, the JS global proxy name, the log tag) is stamped
  with a short prefix the user chooses, so the generated module can't collide
  with symbols from another native module in the same app.

This skill does **not** scaffold a new npm package from scratch — it operates
on a project that `create-react-native-library` already generated (which
brings its own `package.json`, `example/` app, podspec, tsconfig, etc.). The
actual work is running `scripts/generate.mjs` in this skill's directory
against that project, then walking the user through the follow-up steps it
can't automate (pod install, first build).

## 0. Make sure there's a builder-bob project to work in

Check the target directory's `package.json` for a `"react-native-builder-bob"`
or `"create-react-native-library"` key (the generator does this check too and
will refuse to run without one). If it's missing, tell the user to scaffold
the library first:

```
npx create-react-native-library@latest <name> --type turbo-module --languages kotlin-objc
```

Then re-run this skill from inside that new directory. Don't try to invent a
package.json/podspec/tsconfig yourself — that's exactly what
`create-react-native-library` is for, and this skill's templates assume that
scaffold already exists.

## 1. Collect inputs

Ask the user for (skip anything they already gave you up front, or can read
from the existing `package.json`):

1. **Prefix** — a short PascalCase word, 3-6 letters, e.g. `Acme`. This is
   stamped onto every generated identifier: C++ namespace (lowercased),
   class/file names (`{Prefix}Module`, `{Prefix}ThreadPool`, `{Prefix}Bridge`
   ...), the JS global proxy (`__{Prefix}Proxy`), the Android log tag, and
   the internal HFN macro names. Reject single-letter or generic prefixes
   like `RN` — the whole point is collision-avoidance.
2. **Java package** — reverse-domain, e.g. `com.acme.kit`. Defaults to
   whatever `codegenConfig.android.javaPackageName` is already set to in the
   project's `package.json` (i.e. whatever the user picked when running
   `create-react-native-library`) — only ask if that's missing.

Don't ask about npm package name, output directory, description, or author —
those already exist in the target project's `package.json` and are read
directly from it. Don't ask about SQLite, encryption, multiple backends, or
anything else op-sqlite-specific — this skill produces a minimal example
module (an `Example` HostObject exposing one sync method and one async
method) that the user extends themselves. Don't invent extra scope beyond
that example.

## 2. Run the generator

From this skill's directory, with the working directory (or `--dir`) pointed
at the existing builder-bob project:

```
node scripts/generate.mjs \
  --prefix "<Prefix>" \
  --package "<java.package.name>" \
  --dir "<path-to-existing-project>"
```

`--dir` defaults to `.`. The generator overwrites only the native entry-point
files (`cpp/`, `ios/{Prefix}.h/.mm`, `android/build.gradle`,
`android/CMakeLists.txt`, the Kotlin bridge/module/package files, the
podspec, `src/Native{Prefix}.ts`, `src/index.ts`) and patches
`package.json`'s `codegenConfig.android.javaPackageName` — it leaves the rest
of the create-react-native-library scaffold (root `package.json` metadata,
README, tsconfig, the `example/` app) alone. It also deletes leftovers from
whichever default example TurboModule create-react-native-library generated
once they're superseded — e.g. the "kotlin-objc" type's default
`{Name}Module.kt`/`{Name}.h/.mm`/`Native{Name}.ts`, or the "cpp" type's
`cpp/{Name}Impl.h/.cpp` (a fully codegen'd Cxx spec — a different,
incompatible architecture from this skill's hand-written JNI bridge) — and
prints what it removed. If the project was scaffolded with
`--languages cpp`, it also deletes the root `react-native.config.js` that
type generates: it declares `cxxModuleCMakeListsPath`/`cxxModuleHeaderName`
pointing at a build-generated `android/generated/jni` that only exists for
that fully-codegen'd architecture, and leaving it in place makes RN's
autolinking try to `add_subdirectory` a path that never gets created,
breaking the Android CMake configure step.

Run it, then `ls` a couple of the rewritten directories and skim 2-3
generated files (e.g. `cpp/{Prefix}Module.cpp`, `android/build.gradle`, the
podspec) to confirm the substitution actually ran cleanly — no leftover
`__TOKEN__` placeholders. Grep for `__` followed by uppercase to catch any
missed token quickly: `grep -rn '__[A-Z_]*__' <project-dir>` should return
nothing outside of `node_modules`/`lib`/`example`.

## 3. Explain what was generated

Summarize for the user, briefly, mapping back to the architecture:

- `cpp/{Prefix}Module.{hpp,cpp}` — the `install()`/`invalidate()` entry point
  that both platforms call into; this is where they'll register more
  HostObjects on the global proxy.
- `cpp/ExampleHostObject.{hpp,cpp}` — the template for a JSI HostObject, with
  three methods to copy from: `add` (sync, built with the `HFN` macro),
  `computeAsync` (async, `promisify()` + the per-instance `ThreadPool`), and
  `labelItems` (sync, converts a JS array with `to_string_vec()` and returns
  an array of objects with `create_object_array()`).
- `cpp/{Prefix}Types.hpp` — the `JSVariant` variant type and `ArrayBuffer`
  struct that every JSI <-> C++ conversion should be expressed in terms of.
  Prefixed (not just `types.hpp`) so it can't collide with another
  pure-C++ module's own `types.hpp` in the same app.
- `cpp/{Prefix}Utils.{hpp,cpp}` — `to_jsi()`/`to_variant()` (and the
  `to_string_vec()`/`to_int_vec()`/`to_variant_vec()` array forms): the only
  functions that should ever convert between `jsi::Value` and C++ — don't
  hand-roll a conversion at a call site, add a `JSVariant` alternative and
  teach it to these instead. Also prefixed for the same collision-avoidance
  reason as `{Prefix}Types.hpp`. Also `create_object_array()`, which builds an
  array of same-shaped objects (e.g. query-result rows) by creating each
  column's `jsi::PropNameID` **once**, outside the row loop, and reusing it
  for every row's `setProperty()` call — recomputing a `PropNameID` per cell
  instead of per column is a real, measurable cost at scale, not a
  micro-optimization. Reuse this "build the PropNameID cache before the
  loop" pattern whenever setting the same property names on many objects.
- `cpp/{Prefix}ThreadPool.{hpp,cpp}`, `cpp/logs.h`, `cpp/macros.hpp` —
  copied straight from the op-sqlite patterns, renamed to the chosen prefix.
- `ios/{Prefix}.{h,mm}` — the Objective-C++ TurboModule that exposes
  `install()` as `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` and forwards the
  JSI runtime + CallInvoker into C++.
- `android/cpp-adapter.cpp` + `{Prefix}Bridge.kt` + `{Prefix}Module.kt` +
  `{Prefix}Package.kt` — the JNI/fbjni path that does the Android equivalent.
- `android/build.gradle`, `android/CMakeLists.txt`, the podspec — the build
  wiring; no backend-switching logic like op-sqlite has, just a plain CMake
  + prefab / CocoaPods setup compiling everything under `cpp/`. The podspec
  and CMake `PACKAGE_NAME` keep the pod/library identity
  `create-react-native-library` already created (the kebab-case npm package
  name) — only the C++/Kotlin symbols inside get the chosen prefix.
- `src/Native{Prefix}.ts` — the minimal codegen spec, just `install()`.
- `src/index.ts` — calls `install()` once, reads `global.__{Prefix}Proxy`,
  and re-exports a typed wrapper.

## 4. Follow-up steps to tell the user (don't do these yourself unless asked)

- If `package.json`'s `repository`/`homepage`/`bugs` URLs are still
  placeholders from `create-react-native-library`, the podspec reads
  `repository.url` at pod install time — point these at the real repo before
  publishing.
- `yarn install` (or `npm install`) at the project root to pick up the
  `codegenConfig` change.
- The project's bundled `example/` app already depends on the library locally
  — rebuild it: `cd example && yarn pods` (iOS) then run it, or just
  `yarn example ios` / `yarn example android` from the root, depending on
  how `create-react-native-library` wired the example's scripts.
- Extending the module: add new HostObjects under `cpp/`, register them on
  the proxy in `{Prefix}Module.cpp`'s `install()`, and expose typed
  wrappers from `src/index.ts`. No codegen changes needed for new methods —
  that's the entire point of this architecture. Any new JSI <-> C++
  conversion should go through `to_jsi()`/`to_variant()` in `{Prefix}Utils.hpp`
  (add a `JSVariant` alternative in `{Prefix}Types.hpp` if the existing ones don't
  cover the shape needed), and any new HostFunction returning many
  same-shaped objects should use `create_object_array()` rather than calling
  `jsi::PropNameID::forUtf8()` inside the row loop.

Treat build/link errors the user reports afterward as normal debugging, not
as a sign the scaffold is broken — cross-check against `scripts/generate.mjs`
output and the templates it drew from before assuming the generator itself
is at fault.
