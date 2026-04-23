// Phase 5a — per-module config storage.
//
// Files live at `~/.rn-dev/modules/<id>/config.json` alongside the existing
// `disabled.flag` (Phase 3c). Reads are tolerant — missing/corrupt file →
// `{}`. Writes are atomic via tmpfile + rename so a mid-write crash cannot
// leave a half-baked JSON blob.
//
// Schema validation uses the same `ajv/dist/2020` path as
// `define-module.ts` so authors' `contributes.config.schema` uses JSON Schema
// 2020-12 semantics. Compiled validators are cached per (moduleId, schema-
// identity) — re-compiling on every `set` would be wasted work for the
// common case (the schema only changes when the module is re-installed).
//
// No cross-process locking. Two concurrent `set` calls for the same module
// race at the file level; whichever rename wins is the final state. Fine
// for a single-daemon host; revisit if we ever run multiple daemon
// processes for the same user.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import Ajv, { type ValidateFunction } from "ajv/dist/2020.js";

import { defaultModulesRoot } from "./disabled-flag.js";

export const CONFIG_FILENAME = "config.json";

export interface ConfigValidationError {
  path: string;
  message: string;
  keyword: string;
}

export type ConfigValidationResult =
  | { valid: true }
  | { valid: false; errors: ConfigValidationError[] };

export interface ModuleConfigStoreOptions {
  /** Root directory. Defaults to `~/.rn-dev/modules/`. */
  modulesDir?: string;
}

/**
 * Thin filesystem wrapper around per-module config blobs + a JSON-Schema
 * validator cache. Construct once per daemon; share via `ModuleHostManager`,
 * `registerModulesIpc`, and the Electron IPC layer so they all hit the same
 * on-disk state.
 */
export class ModuleConfigStore {
  private readonly modulesDir: string;
  private readonly ajv: Ajv;
  /**
   * Cache keyed by schema identity (object reference). Re-compiling ajv on
   * every `validate` call is measurable — the hot path is `modules/config/set`
   * which runs on every user edit.
   */
  private readonly validators = new WeakMap<object, ValidateFunction>();

  constructor(options: ModuleConfigStoreOptions = {}) {
    this.modulesDir = options.modulesDir ?? defaultModulesRoot();
    this.ajv = new Ajv({ allErrors: true, strict: false });
  }

  /**
   * Directory that holds the module's on-disk state — config + disabled flag.
   */
  rootFor(moduleId: string): string {
    return join(this.modulesDir, moduleId);
  }

  /**
   * Absolute path of the module's config.json. Exposed for tests that want
   * to assert the file layout matches the documented contract.
   */
  pathFor(moduleId: string): string {
    return join(this.rootFor(moduleId), CONFIG_FILENAME);
  }

  /**
   * Read the current config. Missing file or unparseable JSON → `{}`. Never
   * throws — a crash on startup because someone hand-edited their config
   * file would be the worst possible DX.
   */
  get(moduleId: string): Record<string, unknown> {
    const path = this.pathFor(moduleId);
    if (!existsSync(path)) return {};
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through to empty */
    }
    return {};
  }

  /**
   * Validate `candidate` against the provided schema. `schema` may be
   * `undefined` — modules that don't declare a `contributes.config.schema`
   * get no validation. Compiled validators are cached by schema identity.
   */
  validate(
    candidate: unknown,
    schema: Record<string, unknown> | undefined,
  ): ConfigValidationResult {
    if (!schema) return { valid: true };
    const validator = this.validatorFor(schema);
    if (validator(candidate)) return { valid: true };
    return {
      valid: false,
      errors: (validator.errors ?? []).map((err) => ({
        path: err.instancePath || "/",
        message: err.message ?? "invalid",
        keyword: err.keyword,
      })),
    };
  }

  /**
   * Atomically write `config` for `moduleId`. Caller is responsible for
   * validation — see `validate()`. Creates the module's root dir if needed.
   *
   * Modes: module dir `0o700`, config file `0o600`. Module configs carry
   * security-sensitive toggles (e.g. `captureBodies`); the file lives
   * under `~/.rn-dev/modules/<id>/` and must not be world-readable by
   * default. Best-effort — POSIX only; Windows ACLs are whatever `fs`
   * gives us there.
   */
  write(moduleId: string, config: Record<string, unknown>): void {
    const path = this.pathFor(moduleId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    try {
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* leftover tmp files are harmless */
      }
      throw err;
    }
  }

  private validatorFor(schema: Record<string, unknown>): ValidateFunction {
    const cached = this.validators.get(schema);
    if (cached) return cached;
    const compiled = this.ajv.compile(schema);
    this.validators.set(schema, compiled);
    return compiled;
  }
}
