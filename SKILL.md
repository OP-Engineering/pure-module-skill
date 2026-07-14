---
name: create-pure-module
description: Scaffold a new React Native "pure C++" native module — a TurboModule used only as a thin install() entry point that then hands off to hand-written JSI HostObjects in C++, instead of codegen'd TurboModule methods. Use when the user wants to create a new native module like op-sqlite (fast, no codegen boilerplate for the actual API surface), asks to "create a C++ RN module", "scaffold a JSI library", or references this skill by name.
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

Scaffolds a new React Native library that follows the **op-sqlite architecture**:

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

This is a scaffolding task, not a from-scratch design task — the actual work
is running `scripts/generate.mjs` in this skill's directory with the right
arguments and then walking the user through the follow-up steps it can't
automate (pod install, first build).

## 1. Collect inputs

Ask the user for (skip anything they already gave you up front):

1. **npm package name** — e.g. `react-native-acme-kit` or a scoped name like
   `@acme/rn-kit`. This becomes the `name` in package.json.
2. **Prefix** — a short PascalCase word, 3-6 letters, e.g. `Acme`. This is
   stamped onto every generated identifier: C++ namespace (lowercased),
   class/file names (`{Prefix}Module`, `{Prefix}ThreadPool`, `{Prefix}Bridge`
   ...), the JS global proxy (`__{Prefix}Proxy`), the Android log tag, and
   the internal HFN macro names. Reject single-letter or generic prefixes
   like `RN` — the whole point is collision-avoidance.
3. **Java package** — reverse-domain, e.g. `com.acme.kit`. Used for the
   Android Kotlin package and namespace.
4. **Output directory** — where to write the module. Default to a new
   directory next to the current project named after the npm package
   (kebab-cased, scope stripped), e.g. `./react-native-acme-kit`. If the
   user is already inside an empty directory meant for this module, offer to
   scaffold in place (`.`).
5. **Description** and **author** — one-liners, used in package.json and the
   podspec. Fine to default to something short and ask the user to edit
   later if they don't care.

Don't ask about SQLite, encryption, multiple backends, or anything else
op-sqlite-specific — this skill produces a minimal example module (an
`Example` HostObject exposing one sync method and one async method) that the
user extends themselves. Don't invent extra scope beyond that example.

## 2. Run the generator

From this skill's directory:

```
node scripts/generate.mjs \
  --name "<npm-package-name>" \
  --prefix "<Prefix>" \
  --package "<java.package.name>" \
  --dir "<output-dir>" \
  --description "<description>" \
  --author "<author>"
```

The script is idempotent-safe about *not* clobbering a non-empty output
directory — if it refuses because the directory exists and has files, ask
the user whether to pick a different directory or confirm overwrite, then
re-run with `--force` only if they explicitly confirm.

Run it, then `ls` the output directory and skim 2-3 generated files (e.g.
`cpp/{Prefix}Module.cpp`, `android/build.gradle`, the podspec) to confirm the
substitution actually ran cleanly — no leftover `__TOKEN__` placeholders.
Grep for `__` followed by uppercase to catch any missed token quickly:
`grep -rn '__[A-Z_]*__' <output-dir>` should return nothing.

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
- `cpp/types.hpp` — the `JSVariant` variant type and `ArrayBuffer` struct
  that every JSI <-> C++ conversion should be expressed in terms of.
- `cpp/utils.{hpp,cpp}` — `to_jsi()`/`to_variant()` (and the
  `to_string_vec()`/`to_int_vec()`/`to_variant_vec()` array forms): the only
  functions that should ever convert between `jsi::Value` and C++ — don't
  hand-roll a conversion at a call site, add a `JSVariant` alternative and
  teach it to these instead. Also `create_object_array()`, which builds an
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
  + prefab / CocoaPods setup compiling everything under `cpp/`.
- `src/Native{Prefix}.ts` — the minimal codegen spec, just `install()`.
- `src/index.ts` — calls `install()` once, reads `global.__{Prefix}Proxy`,
  and re-exports a typed wrapper.

## 4. Follow-up steps to tell the user (don't do these yourself unless asked)

- `package.json`'s `repository`/`homepage`/`bugs` URLs are placeholders
  (`github.com/CHANGEME/...`) — the podspec reads `repository.url` at pod
  install time, so point these at the real repo before publishing.
- `yarn install` / `npm install` inside the new module directory.
- Wiring it into a test app: either `npm link` / `yalc`, or generate a
  fresh example app with `npx @react-native-community/cli init` and add the
  module as a local dependency — this skill doesn't scaffold an example app.
- iOS: `cd example/ios && pod install` once linked into an app.
- Android: nothing extra needed beyond a normal `./gradlew` build — prefab
  headers are wired up in the generated `build.gradle`.
- Extending the module: add new HostObjects under `cpp/`, register them on
  the proxy in `{Prefix}Module.cpp`'s `install()`, and expose typed
  wrappers from `src/index.ts`. No codegen changes needed for new methods —
  that's the entire point of this architecture. Any new JSI <-> C++
  conversion should go through `to_jsi()`/`to_variant()` in `utils.hpp`
  (add a `JSVariant` alternative in `types.hpp` if the existing ones don't
  cover the shape needed), and any new HostFunction returning many
  same-shaped objects should use `create_object_array()` rather than calling
  `jsi::PropNameID::forUtf8()` inside the row loop.

Treat build/link errors the user reports afterward as normal debugging, not
as a sign the scaffold is broken — cross-check against `scripts/generate.mjs`
output and the templates it drew from before assuming the generator itself
is at fault.
