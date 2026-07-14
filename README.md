# create-pure-module

Scaffolds a new React Native native module that follows the **op-sqlite
architecture**: a TurboModule used only as a thin, blocking-synchronous
`install()` entry point that hands the JSI `Runtime` and `CallInvoker` to
hand-written C++. The actual API surface is plain JSI — `HostObject`s and
`HostFunction`s — not codegen'd TurboModule methods. This avoids the
serialization overhead and per-method codegen boilerplate of a normal
TurboModule, at the cost of writing the JSI glue by hand.

This is a scaffolding tool for **pure C++ modules only** — no Swift/Kotlin
API surface, no Nitro/Expo module conventions. If you want a "normal"
TurboModule or Nitro module, this isn't the tool for that.

## What you get

- A per-HostObject `ThreadPool` + `promisify()` helper for async work:
  background thread does the blocking work, `CallInvoker::invokeAsync` hops
  back to the JS thread to resolve/reject the `Promise`.
- `HFN`/`HFN2`/`HFN3` HostFunction-creation macros, prefixed with your
  module's chosen prefix so they can't collide with another native module's
  macros in the same translation unit.
- iOS (Objective-C++ TurboModule + podspec) and Android (fbjni JNI bridge +
  Kotlin TurboModule + CMake/prefab `build.gradle`) wiring, with no
  codegen required for anything beyond the single `install()` call.
- Every generated identifier — C++ namespace, class/file names, the JNI
  class descriptor, the `global.__{Prefix}Proxy` JS bridge object, the
  Android log tag — is stamped with a prefix you choose, so the generated
  module can't collide with another native module's symbols in the same
  app.
- `to_jsi()`/`to_variant()` in `utils.hpp`: the single place every JSI <->
  C++ conversion goes through, built on a `JSVariant` type you extend as
  needed, instead of hand-rolled `jsi::Value` reads/writes scattered across
  HostFunctions.
- `create_object_array()`: builds an array of same-shaped objects (e.g.
  query-result rows) by creating each column's `jsi::PropNameID` once,
  outside the row loop, instead of re-interning the same property name once
  per cell — a real performance win once you're returning more than a
  handful of rows.
- An `ExampleHostObject` showing all three patterns: a synchronous method
  (`add`), an async method (`computeAsync`) built with `promisify()`, and a
  method returning an object array (`labelItems`) built with
  `to_string_vec()` + `create_object_array()`.

## Usage

```sh
npx create-pure-module \
  --name react-native-acme-kit \
  --prefix Acme \
  --package com.acme.kit \
  --dir ./react-native-acme-kit \
  --description "Acme kit for React Native" \
  --author "Jane Doe"
```

Omit any flag and it'll prompt for it interactively (as long as stdin is a
TTY). See `SKILL.md` for what each flag means and the full list of files it
generates.

### As a Claude Code skill

This repo is also a Claude Code skill
(`skills/create-pure-module/SKILL.md`). Install it into a project with the
[`skills` CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add OP-Engineering/pure-module-skill
```

This copies `skills/create-pure-module/` into `.claude/skills/` (or the
equivalent directory for your agent) and Claude can drive the scaffolding
interactively via `/create-pure-module`. You can also drop the
`skills/create-pure-module/` directory in by hand into `.claude/skills/`
in a project (or a personal `~/.claude/skills/`).

## After scaffolding

The generated module has no bundled example app. To try it:

1. `cd` into the generated directory, `yarn install` (or `npm install`).
2. Create a test app (`npx @react-native-community/cli init`) and add the
   generated module as a local dependency (`npm link`, `yalc`, or a `file:`
   dependency).
3. iOS: `pod install` in the test app.
4. Android: build normally — prefab headers are wired up already.

Extend it by adding new `HostObject`s under `cpp/` (copy
`ExampleHostObject` as a starting point) and registering them in
`{Prefix}Module.cpp`'s `install()`. No codegen changes needed for new
methods.

## License

MIT
