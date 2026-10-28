/**
 * Detect a repo's stack and recommend a quality-check playbook.
 *
 * The rules are data (data/recommendations.yaml); this module only detects, evaluates the closed
 * set of predicates the rules may use, and assembles the playbook. No network, no subprocesses.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parse, stringify } from "yaml";
import { SatoriError } from "./errors.js";
import { pyRepr } from "./pyrepr.js";

type Dict = Record<string, any>;

export const CATEGORIES = ["lint", "format", "types", "unit", "security"] as const;
const HEADER_RE = /^#\s*satori:recommended\s+v(\d+)\s+(\S+)(?:\s+prefs:\s*(.*?))?\s*$/m;
export const LLM_PLAYBOOK = ".satori-llm.yml";
export const CI_PLAYBOOK = ".satori.yml";
export const LLM_IMPORT = "file://.satori-llm.yml";
const PREDICATES = ["has_file", "has_dir", "has_dep", "pkg_script", "manager", "has_any"];
const LANGUAGES = [
  "python",
  "node",
  "go",
  "java",
  "csharp",
  "rust",
  "ruby",
  "php",
  "swift",
  "cpp",
  "solidity",
  "dart",
];
const MANAGERS: Record<string, string> = {
  go: "go",
  csharp: "dotnet",
  rust: "cargo",
  ruby: "bundler",
  php: "composer",
  swift: "swiftpm",
  cpp: "cmake",
  solidity: "foundry",
};

const RULES_PATH = new URL("../data/recommendations.yaml", import.meta.url);

/** PyYAML-like output: block style, unindented sequences, no line folding. */
export function dumpYaml(value: unknown): string {
  return stringify(value, { indentSeq: false, lineWidth: 0, singleQuote: true });
}

// ------------------------------------------------------------------------------ glob
/** Escapes everything but the glob metacharacters `*`, `?` and `[...]`. */
function escapeRegex(s: string): string {
  return s.replace(/[.+^${}()|\\]/g, "\\$&");
}

function escapeRegexFull(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function segmentRegex(segment: string): RegExp {
  return new RegExp(`^${escapeRegex(segment).replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
}

/** pathlib-style glob for the simple patterns the rules use (`*`, `?`, `[...]`, `dir/*.ext`). */
export function glob(root: string, pattern: string): string[] {
  let current = [root];
  for (const segment of pattern.split("/")) {
    const regex = segmentRegex(segment);
    const next: string[] = [];
    for (const dir of current) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of entries.sort()) if (regex.test(name)) next.push(join(dir, name));
    }
    current = next;
  }
  return current;
}

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const isDir = (path: string) => existsSync(path) && statSync(path).isDirectory();

// --------------------------------------------------------------------------- profile
export class Profile {
  otherLanguages: string[] = [];
  hasLockfile = true;
  pyproject = "";
  requirements = "";
  packageJson: Dict = {};
  manifest = "";
  composerJson: Dict = {};

  constructor(
    readonly root: string,
    public language: string,
    public manager: string,
    init: Partial<Profile> = {},
  ) {
    Object.assign(this, init);
  }

  hasFile(pattern: string): boolean {
    return glob(this.root, pattern).length > 0;
  }

  hasDir(name: string): boolean {
    return isDir(join(this.root, name));
  }

  hasDep(name: string): boolean {
    const pattern = new RegExp(`(?<![\\w.-])${escapeRegexFull(name)}(?![\\w.-])`, "i");
    if (this.language === "python") return pattern.test(this.pyproject) || pattern.test(this.requirements);
    if (this.language === "ruby" || this.language === "rust") return pattern.test(this.manifest);
    if (this.language === "node") {
      return ["dependencies", "devDependencies"].some((k) => name in (this.packageJson[k] ?? {}));
    }
    if (this.language === "php") {
      return ["require", "require-dev"].some((k) => name in (this.composerJson[k] ?? {}));
    }
    if (this.language === "dart") {
      let pubspec: Dict = {};
      try {
        pubspec = (parse(this.manifest) as Dict) || {};
      } catch {
        return false;
      }
      return ["dependencies", "dev_dependencies", "dependency_overrides"].some(
        (k) => name in (pubspec[k] ?? {}),
      );
    }
    return false;
  }

  pkgScript(name: string): boolean {
    const script = (this.packageJson.scripts ?? {})[name];
    return Boolean(script) && !String(script).includes("no test specified");
  }

  hasPyprojectSection(path: string): boolean {
    return new RegExp(`^\\[\\s*${escapeRegexFull(path)}(\\.|\\s*\\])`, "m").test(this.pyproject);
  }
}

export interface Recommendation {
  profile: Profile;
  rulesVersion: number;
  playbook: Dict;
  header: string;
  checks: Dict[];
  questions: Dict[];
  prefsUsed: Dict;
  notes: string[];
  install: string[];
  yaml: string;
}

// ----------------------------------------------------------------------------- rules
let cachedRules: Dict | undefined;

export function loadRules(): Dict {
  if (!cachedRules) {
    cachedRules = parse(readFileSync(RULES_PATH, "utf-8")) as Dict;
    validateRules(cachedRules);
  }
  return cachedRules;
}

/** Test hook: replace the loaded rules (undefined reloads from disk). */
export function setRules(rules: Dict | undefined): void {
  cachedRules = rules;
}

function checkWhen(toolId: string, when: Dict): void {
  for (const [key, value] of Object.entries(when)) {
    if (!PREDICATES.includes(key)) throw new Error(`${toolId}: unknown predicate ${pyRepr(key)}`);
    if (key === "has_any") for (const sub of value) checkWhen(toolId, sub);
  }
}

function prefToolValue(tool: Dict): [string, unknown] | null {
  const pref = tool.pref;
  if (!pref) return null;
  return typeof pref === "object" ? (Object.entries(pref)[0] as [string, unknown]) : [pref, true];
}

/** Throw if the rules use anything outside the closed vocabulary. */
export function validateRules(rules: Dict): void {
  const prefs = rules.prefs;
  const seen = new Set<string>();
  for (const tool of rules.tools) {
    const tid = tool.id;
    if (seen.has(tid)) throw new Error(`duplicate tool id ${tid}`);
    seen.add(tid);
    if (!(CATEGORIES as readonly string[]).includes(tool.category)) {
      throw new Error(`${tid}: unknown category ${pyRepr(tool.category)}`);
    }
    if (![...LANGUAGES, "dockerfile"].includes(tool.language)) {
      throw new Error(`${tid}: unknown language ${pyRepr(tool.language)}`);
    }
    if (!["python-tool", "tool", "project"].includes(tool.kind)) {
      throw new Error(`${tid}: unknown kind ${pyRepr(tool.kind)}`);
    }
    if ((tool.kind === "python-tool" || tool.kind === "tool") && !(tool.package && tool.version)) {
      throw new Error(`${tid}: ${tool.kind} needs package and version`);
    }
    if (tool.kind === "tool") {
      const managers = Object.values(rules.profiles[tool.language] ?? {}) as Dict[];
      if (!managers.length || !managers.every((m) => "tool_install" in m)) {
        throw new Error(`${tid}: every ${tool.language} profile needs tool_install`);
      }
    }
    if (!(tool.severity >= 0 && tool.severity <= 5)) throw new Error(`${tid}: severity must be 0-5`);
    if (tool.since > rules.rules_version) throw new Error(`${tid}: since is newer than rules_version`);
    checkWhen(tid, tool.when ?? {});
    const pv = prefToolValue(tool);
    if (pv) {
      const [key, value] = pv;
      if (!(key in prefs)) throw new Error(`${tid}: unknown pref ${pyRepr(key)}`);
      if (prefs[key].type === "choice" && !prefs[key].choices.includes(value)) {
        throw new Error(`${tid}: ${pyRepr(value)} is not a choice of ${key}`);
      }
    }
    for (const token of tool.configured_by ?? []) {
      if (!["file", "pyproject", "dep"].includes(token.split(":", 1)[0])) {
        throw new Error(`${tid}: bad configured_by token ${pyRepr(token)}`);
      }
    }
  }
  for (const [lang, managers] of Object.entries(rules.profiles as Dict)) {
    if (!LANGUAGES.includes(lang)) throw new Error(`unknown profile language ${pyRepr(lang)}`);
    for (const [manager, data] of Object.entries(managers as Dict)) {
      if (!("image" in data) || !("run" in data)) throw new Error(`profile ${lang}/${manager} needs image and run`);
    }
  }
}

// ------------------------------------------------------------------------- detection
function read(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function parseJsonFile(path: string, name: string): Dict {
  try {
    return JSON.parse(read(path)) || {};
  } catch {
    throw new SatoriError(`${name} is not valid JSON.`);
  }
}

export function detect(root: string): Profile {
  const has = (name: string) => isFile(join(root, name));
  const found: string[] = [];
  if (["pyproject.toml", "setup.py", "Pipfile"].some(has) || glob(root, "requirements*.txt").length) {
    found.push("python");
  }
  // Foundry repos usually carry a package.json too; Solidity must win over Node.
  if (has("foundry.toml")) found.push("solidity");
  if (has("package.json")) found.push("node");
  if (has("go.mod")) found.push("go");
  if (has("pom.xml") || glob(root, "build.gradle*").length) found.push("java");
  if (["*.sln", "*.csproj", "*/*.csproj"].some((p) => glob(root, p).length)) found.push("csharp");
  for (const [manifest, lang] of [
    ["Cargo.toml", "rust"],
    ["Gemfile", "ruby"],
    ["composer.json", "php"],
    ["Package.swift", "swift"],
    ["CMakeLists.txt", "cpp"],
    ["pubspec.yaml", "dart"],
  ]) {
    if (has(manifest)) found.push(lang);
  }
  if (!found.length) {
    throw new SatoriError(
      "No supported project detected (looked for Python, JS/TS, Go, Java, C#, " +
        `Rust, Ruby, PHP, Swift, C/C++, Solidity and Dart/Flutter manifests) in ${root}.`,
    );
  }

  const language = found[0];
  const profile = new Profile(root, language, "", { otherLanguages: found.slice(1) });
  profile.pyproject = read(join(root, "pyproject.toml"));
  profile.requirements = glob(root, "requirements*.txt").map(read).join("\n");
  if (language === "node") profile.packageJson = parseJsonFile(join(root, "package.json"), "package.json");
  else if (language === "php") profile.composerJson = parseJsonFile(join(root, "composer.json"), "composer.json");
  else if (language === "ruby") profile.manifest = `${read(join(root, "Gemfile"))}\n${read(join(root, "Gemfile.lock"))}`;
  else if (language === "rust") profile.manifest = read(join(root, "Cargo.toml"));
  else if (language === "dart") profile.manifest = read(join(root, "pubspec.yaml"));

  if (language === "python") {
    const uv = has("uv.lock") || profile.hasPyprojectSection("tool.uv");
    profile.manager = uv ? "uv" : "pip";
  } else if (language === "node") {
    const declared = String(profile.packageJson.packageManager ?? "").split("@")[0];
    const locks: Record<string, string> = {
      pnpm: "pnpm-lock.yaml",
      yarn: "yarn.lock",
      bun: "bun.lock*",
      npm: "package-lock.json",
    };
    const byLock = Object.entries(locks).find(([, f]) => glob(root, f).length)?.[0];
    profile.manager = declared in locks ? declared : (byLock ?? "npm");
    profile.hasLockfile = glob(root, locks[profile.manager]).length > 0;
  } else if (language === "java") {
    profile.manager = has("pom.xml") ? "maven" : "gradle";
  } else if (language === "dart") {
    // Flutter apps declare `sdk: flutter` and/or a top-level `flutter:` section.
    const flutter =
      /^\s*flutter\s*:/m.test(profile.manifest) ||
      /sdk\s*:\s*flutter\b/.test(profile.manifest);
    profile.manager = flutter ? "flutter" : "dart";
  } else {
    profile.manager = MANAGERS[language];
  }
  return profile;
}

/** Shorten scoped/path package names: `@org/pkg` → `pkg`, `a/b/c` → `c`. */
function shortLabel(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withoutScope = trimmed.startsWith("@") ? trimmed.slice(trimmed.lastIndexOf("/") + 1) : trimmed;
  const segment = withoutScope.includes("/") ? withoutScope.slice(withoutScope.lastIndexOf("/") + 1) : withoutScope;
  return segment.trim() || null;
}

function tomlName(text: string, section?: string): string | null {
  if (section) {
    const block = new RegExp(
      `^\\[\\s*${escapeRegexFull(section)}\\s*\\]\\s*([\\s\\S]*?)(?=^\\[|$)`,
      "m",
    ).exec(text);
    if (!block) return null;
    text = block[1];
  }
  const match = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
  return match ? shortLabel(match[1]) : null;
}

function yamlTopName(text: string): string | null {
  const match = /^name:\s*["']?([^\s"'#]+)/m.exec(text);
  return match ? shortLabel(match[1]) : null;
}

/**
 * Best-effort project label for `settings.name`. Manifest fields first, then the
 * directory basename; null when nothing useful is available (name is optional).
 */
export function projectName(profile: Profile): string | null {
  let fromManifest: string | null = null;
  if (profile.language === "node") {
    fromManifest = typeof profile.packageJson.name === "string" ? shortLabel(profile.packageJson.name) : null;
  } else if (profile.language === "python") {
    fromManifest = tomlName(profile.pyproject, "project") ?? tomlName(profile.pyproject, "tool.poetry");
  } else if (profile.language === "rust") {
    fromManifest = tomlName(profile.manifest, "package");
  } else if (profile.language === "dart") {
    fromManifest = yamlTopName(profile.manifest);
  } else if (profile.language === "php") {
    fromManifest = typeof profile.composerJson.name === "string" ? shortLabel(profile.composerJson.name) : null;
  } else if (profile.language === "go") {
    const mod = /^\s*module\s+(\S+)/m.exec(read(join(profile.root, "go.mod")));
    fromManifest = mod ? shortLabel(mod[1]) : null;
  }
  if (fromManifest) return fromManifest;

  const base = basename(profile.root);
  if (!base || base === "." || base === "/" || base === "\\") return null;
  return shortLabel(base);
}

// ------------------------------------------------------------------------ predicates
function evalWhen(profile: Profile, when: Dict): boolean {
  for (const [key, value] of Object.entries(when)) {
    let ok: boolean;
    if (key === "has_file") ok = profile.hasFile(value);
    else if (key === "has_dir") ok = profile.hasDir(value);
    else if (key === "has_dep") ok = profile.hasDep(value);
    else if (key === "pkg_script") ok = profile.pkgScript(value);
    else if (key === "manager") ok = value.includes(profile.manager);
    else ok = (value as Dict[]).some((sub) => evalWhen(profile, sub)); // has_any
    if (!ok) return false;
  }
  return true;
}

function configured(profile: Profile, tool: Dict): boolean {
  for (const token of tool.configured_by ?? []) {
    const idx = token.indexOf(":");
    const kind = idx === -1 ? token : token.slice(0, idx);
    const arg = idx === -1 ? "" : token.slice(idx + 1);
    if (kind === "file" && profile.hasFile(arg)) return true;
    if (kind === "pyproject" && profile.hasPyprojectSection(arg)) return true;
    if (kind === "dep" && profile.hasDep(arg)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------- header
/** Return [rules_version, prefs] from a `# satori:recommended` header, if present. */
export function parseHeader(text: string): [number, Record<string, string>] | null {
  const match = HEADER_RE.exec(text);
  if (!match) return null;
  const prefs: Record<string, string> = {};
  for (const part of (match[3] ?? "").split(/\s+/)) {
    const idx = part.indexOf("=");
    if (idx !== -1) prefs[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return [Number(match[1]), prefs];
}

export function hasRecommendedHeader(text: string): boolean {
  return parseHeader(text) !== null;
}

/** Minimal `.satori.yml` that installs deps (for CI) and pulls in the LLM playbook. */
export function ciImporterYaml(install: string[] = [], name: string | null = null): string {
  const doc: Dict = {};
  if (name) doc.settings = { name };
  if (install.length) doc.install = install;
  doc.import = [LLM_IMPORT];
  return dumpYaml(doc);
}

/** Install steps from `wanted` that are not already present as strings in `ciText`. */
export function ciInstallMissing(ciText: string, wanted: string[]): string[] {
  let data: unknown;
  try {
    data = parse(ciText) ?? {};
  } catch {
    return [...wanted];
  }
  const present = strings(data);
  return wanted.filter((s) => !present.has(s));
}

/** True if the CI playbook already imports `.satori-llm.yml`. */
export function ciImportsLlm(text: string): boolean {
  let data: unknown;
  try {
    data = parse(text) ?? {};
  } catch {
    return false;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const imports = (data as Dict).import;
  if (typeof imports === "string") return imports === LLM_IMPORT;
  if (Array.isArray(imports)) return imports.includes(LLM_IMPORT);
  return false;
}

export function renderHeader(version: number, profile: Profile, prefs: Dict): string {
  const stack = `${profile.language}/${profile.manager}`;
  const stored = Object.entries(prefs)
    .map(([k, v]) => `${k}=${typeof v === "boolean" ? String(v) : v}`)
    .join(" ");
  return `# satori:recommended v${version} ${stack}` + (stored ? ` prefs: ${stored}` : "");
}

// ----------------------------------------------------------------------------- prefs
function coerce(key: string, spec: Dict, value: unknown): unknown {
  if (spec.type === "bool") {
    if (typeof value === "boolean") return value;
    const lower = String(value).toLowerCase();
    if (lower === "true" || lower === "false") return lower === "true";
    throw new SatoriError(`pref ${pyRepr(key)} must be true or false, got ${pyRepr(value)}.`);
  }
  if (!spec.choices.includes(value)) {
    throw new SatoriError(`pref ${pyRepr(key)} must be one of ${pyRepr(spec.choices)}, got ${pyRepr(value)}.`);
  }
  return value;
}

/** Return [effective prefs, prefs to persist in the header, questions]. */
function resolvePrefs(
  profile: Profile,
  rules: Dict,
  explicit: Dict,
  stored: Dict,
  previousVersion: number | null,
): [Dict, Dict, Dict[]] {
  const specs = Object.entries(rules.prefs as Dict).filter(([, v]) => v.language === profile.language);
  const unknown = Object.keys(explicit).filter((k) => !(k in rules.prefs));
  if (unknown.length) {
    throw new SatoriError(
      `Unknown prefs ${pyRepr(unknown.sort())}; valid: ${pyRepr(Object.keys(rules.prefs).sort())}.`,
    );
  }

  const effective: Dict = {};
  const persist: Dict = {};
  const questions: Dict[] = [];
  for (const [key, spec] of specs) {
    const tied = (rules.tools as Dict[]).filter((t) => prefToolValue(t)?.[0] === key);
    if (key in explicit) {
      effective[key] = persist[key] = coerce(key, spec, explicit[key]);
      continue;
    }
    if (key in stored) {
      effective[key] = persist[key] = coerce(key, spec, stored[key]);
      continue;
    }

    const configuredTools = tied.filter((t) => configured(profile, t));
    if (spec.type === "choice") {
      const choices = new Set(configuredTools.map((t) => prefToolValue(t)![1]));
      if (choices.size === 1) {
        effective[key] = [...choices][0];
        continue;
      }
    } else if (configuredTools.length) {
      effective[key] = true;
      continue;
    }

    effective[key] = spec.default;
    const isNew = previousVersion === null || tied.some((t) => t.since > previousVersion);
    if (isNew) {
      const question: Dict = { pref: key, question: spec.question, default: spec.default };
      if (spec.type === "choice") question.choices = spec.choices;
      questions.push(question);
    }
  }
  return [effective, persist, questions];
}

// ----------------------------------------------------------------------------- build
function format(template: string, values: Dict): string {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

export function renderCommand(profile: Profile, rules: Dict, tool: Dict, install: string[]): string | null {
  const cfg = rules.profiles[profile.language][profile.manager];
  let command = tool.command;
  let verbatim = false;
  if (typeof command === "object" && command !== null) {
    command = command[profile.manager] ?? command.default ?? "";
    verbatim = true;
  }
  if (!command) return null;
  if (command.includes("{pm}")) {
    command = command.split("{pm}").join(cfg.pm ?? "");
    verbatim = true;
  }

  const { package: pkg, version } = tool;
  const addStep = (template: string) => {
    const step = format(template, { package: pkg, version });
    if (!install.includes(step)) install.push(step);
  };
  if (profile.language === "python") {
    if (profile.manager === "uv") {
      if (tool.kind === "python-tool") return format(cfg.tool, { package: pkg, version }) + command;
      if (pkg && !profile.hasDep(pkg)) return `uv run --with ${pkg}==${version} ${command}`;
      return `${cfg.run}${command}`;
    }
    if (pkg && (tool.kind === "python-tool" || !profile.hasDep(pkg))) addStep(cfg.tool_install);
    return `${cfg.run}${command}`;
  }
  if (tool.kind === "tool") {
    addStep(cfg.tool_install);
    return (cfg.tool ?? "") + command;
  }
  return verbatim ? command : `${cfg.run}${command}`;
}

function installSteps(profile: Profile, rules: Dict): string[] {
  const cfg = rules.profiles[profile.language][profile.manager];
  const steps: string[] = [...(profile.hasLockfile ? cfg.install : (cfg.install_nolock ?? cfg.install))];
  for (const [key, step] of Object.entries((cfg.project_install ?? {}) as Dict)) {
    if ((key === "requirements" && profile.requirements) || (key === "project" && profile.pyproject)) {
      steps.push(step);
    }
  }
  return steps;
}

export function build(
  profile: Profile,
  prefs: Dict | null = null,
  previous: [number, Record<string, string>] | null = null,
): Recommendation {
  const rules = loadRules();
  const version: number = rules.rules_version;
  const [previousVersion, stored] = previous ?? [null, {}];
  const [effective, persist, questions] = resolvePrefs(profile, rules, prefs ?? {}, stored, previousVersion);

  const cfg = rules.profiles[profile.language][profile.manager];
  const install = installSteps(profile, rules);
  const notes: string[] = [];
  if (profile.otherLanguages.length) {
    notes.push(
      `Also detected ${profile.otherLanguages.join(", ")}; this recommendation covers ` +
        `${profile.language} only. Run recommend_playbook on the sub-directory for the rest.`,
    );
  }

  const groups: Record<string, Dict> = Object.fromEntries(CATEGORIES.map((c) => [c, {}]));
  const checks: Dict[] = [];
  for (const tool of rules.tools as Dict[]) {
    const language = tool.language;
    if (language === "dockerfile") {
      if (profile.language !== "python") {
        if (evalWhen(profile, tool.when ?? {})) {
          notes.push(
            `Dockerfile found but ${tool.id} needs a Python toolchain; ` + "run a Dockerfile linter separately.",
          );
        }
        continue;
      }
    } else if (language !== profile.language) {
      continue;
    }
    if (!evalWhen(profile, tool.when ?? {})) continue;
    const pv = prefToolValue(tool);
    if (pv && effective[pv[0]] !== pv[1]) continue;
    const command = renderCommand(profile, rules, tool, install);
    if (command === null) {
      notes.push(`${tool.id} has no command for ${profile.manager}; skipped.`);
      continue;
    }

    const blocking = Boolean(tool.blocking_if_present && configured(profile, tool));
    const entry: Dict = {};
    if (blocking) entry.assertReturnCode = 0;
    entry.setSeverity = tool.severity;
    entry.run = [command];
    groups[tool.category][tool.id] = entry;
    checks.push({
      id: tool.id,
      category: tool.category,
      command,
      blocking,
      severity: tool.severity,
      why: tool.why,
      since: tool.since,
    });
  }

  // Install belongs on `.satori.yml` (CI), not the LLM playbook — keep `install` on the
  // recommendation for the CI importer / diffs, but omit it from the LLM YAML.
  const name = projectName(profile);
  const settings: Dict = { image: cfg.image };
  if (name) settings.name = `${name} quality`;
  const playbook: Dict = { settings };
  for (const category of CATEGORIES) {
    if (Object.keys(groups[category]).length) playbook[category] = groups[category];
  }

  if (!checks.some((c) => c.blocking)) {
    notes.push(
      "No check is blocking yet (the repo does not configure these tools): nothing " +
        "fails the playbook, results only show up as findings and output.",
    );
  }

  const header = renderHeader(version, profile, persist);
  return {
    profile,
    rulesVersion: version,
    playbook,
    header,
    checks,
    questions,
    prefsUsed: effective,
    notes,
    install,
    yaml: `${header}\n${dumpYaml(playbook)}`,
  };
}

// ---------------------------------------------------------------------------- update
function strings(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof node === "string") out.add(node);
  else if (Array.isArray(node)) for (const n of node) strings(n, out);
  else if (node !== null && typeof node === "object") for (const v of Object.values(node)) strings(v, out);
  return out;
}

function findTest(playbook: Dict, testId: string): unknown {
  const stack: unknown[] = [playbook];
  while (stack.length) {
    const node = stack.pop();
    if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      if (testId in node) return (node as Dict)[testId];
      stack.push(...Object.values(node));
    }
  }
  return null;
}

/** Compare an existing LLM playbook with the recommendation; the caller does the merge. */
export function diffExisting(existingText: string, rec: Recommendation): Dict {
  let existing: unknown;
  try {
    existing = parse(existingText) ?? {};
  } catch (e) {
    throw new SatoriError(`Existing ${LLM_PLAYBOOK} is not valid YAML: ${e instanceof Error ? e.message : e}`);
  }
  if (typeof existing !== "object" || existing === null || Array.isArray(existing)) {
    throw new SatoriError(`Existing ${LLM_PLAYBOOK} must be a YAML mapping.`);
  }

  const present = strings(existing);
  const missing: Dict[] = [];
  const different: Dict[] = [];
  for (const check of rec.checks) {
    const wanted = rec.playbook[check.category][check.id];
    if (present.has(check.command)) continue;
    const current = findTest(existing as Dict, check.id);
    const fragment = dumpYaml({ [check.category]: { [check.id]: wanted } });
    if (current === null || current === undefined) missing.push({ ...check, suggested_yaml: fragment });
    else different.push({ ...check, existing: current, suggested_yaml: fragment });
  }
  const llmInstall = (existing as Dict).install;
  const moveInstallToCi = Array.isArray(llmInstall)
    ? llmInstall.filter((s): s is string => typeof s === "string")
    : [];
  return {
    missing,
    different,
    ...(moveInstallToCi.length ? { move_install_to_ci: moveInstallToCi } : {}),
    up_to_date: !(missing.length || different.length || moveInstallToCi.length),
  };
}
