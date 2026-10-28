import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SatoriError } from "../src/errors.js";
import * as recommend from "../src/recommend.js";
import { recommendPlaybook } from "../src/tools.js";

const REPOS: Record<string, Record<string, string>> = {
  py_uv: {
    "pyproject.toml": '[project]\nname = "d"\n\n[tool.ruff]\nline-length = 100\n',
    "uv.lock": "",
    "tests/test_ok.py": "def test_ok(): ...\n",
  },
  py_black: {
    "pyproject.toml": '[project]\nname = "d"\n\n[tool.black]\nline-length = 100\n',
    "requirements.txt": "requests\n",
  },
  py_docker: {
    "pyproject.toml": '[project]\nname = "d"\n',
    "uv.lock": "",
    Dockerfile: "FROM python\n",
  },
  node_pnpm: {
    "package.json":
      '{"name": "demo-app", "scripts": {"test": "vitest run"}, "devDependencies": {"eslint": "9"}}',
    "tsconfig.json": "{}",
    "pnpm-lock.yaml": "",
  },
  node_npm_nolock: { "package.json": '{"scripts": {"test": "echo no test specified"}}' },
  node_scoped: {
    "package.json": '{"name": "@acme/widgets", "scripts": {}}',
    "package-lock.json": "",
  },
  go: { "go.mod": "module github.com/acme/widget\n" },
  java_maven: { "pom.xml": "<project/>" },
  csharp: { "App.csproj": "<Project/>" },
  rust: { "Cargo.toml": '[package]\nname = "x"\n' },
  ruby_rails: {
    Gemfile: 'gem "rails"\ngem "rspec-rails"\ngem "rubocop"\n',
    ".rubocop.yml": "",
  },
  php: {
    "composer.json": '{"require-dev": {"phpunit/phpunit": "^11", "phpstan/phpstan": "^2"}}',
    "phpunit.xml": "<phpunit/>",
  },
  swift: { "Package.swift": "// swift-tools-version:6.0\n" },
  cpp: { "CMakeLists.txt": "project(x)\n", ".clang-format": "" },
  solidity: { "foundry.toml": "[profile.default]\n", "package.json": "{}" },
  dart_pkg: {
    "pubspec.yaml": 'name: example\nenvironment:\n  sdk: "^3.0.0"\n',
  },
  flutter_app: {
    "pubspec.yaml":
      'name: example\nenvironment:\n  sdk: "^3.0.0"\n' +
      "dependencies:\n  flutter:\n    sdk: flutter\n" +
      "dev_dependencies:\n  flutter_lints: ^6.0.0\n" +
      "flutter:\n  uses-material-design: true\n",
    "analysis_options.yaml": "include: package:flutter_lints/flutter.yaml\n",
  },
  py_updated: {
    "pyproject.toml": '[project]\nname = "d"\n\n[tool.black]\nline-length = 100\n',
    "uv.lock": "",
    ".satori-llm.yml":
      "# satori:recommended v1 python/uv prefs: formatter=black dead_code=false\n" +
      "settings:\n  name: mine\nlint:\n  ruff_check:\n    run:\n" +
      "    - uvx --from ruff==0.17.0 ruff check --output-format=json .\n",
    ".satori.yml": "import:\n  - file://.satori-llm.yml\n",
  },
  py_legacy_ci: {
    "pyproject.toml": '[project]\nname = "d"\n\n[tool.black]\nline-length = 100\n',
    "uv.lock": "",
    ".satori.yml":
      "# satori:recommended v1 python/uv prefs: formatter=black dead_code=false\n" +
      "settings:\n  name: mine\nlint:\n  ruff_check:\n    run:\n" +
      "    - uvx --from ruff==0.17.0 ruff check --output-format=json .\n",
  },
  py_ci_only: {
    "pyproject.toml": '[project]\nname = "d"\n\n[tool.ruff]\nline-length = 100\n',
    "uv.lock": "",
    "tests/test_ok.py": "def test_ok(): ...\n",
    ".satori.yml": "settings:\n  name: ci\ntest:\n  assertReturnCode: 0\n  unit:\n    - pytest\n",
  },
};

const EXPECTED_IDS: Record<string, string[]> = {
  py_uv: ["ruff_check", "ruff_format", "pytest", "pyrefly", "pyspector"],
  node_pnpm: ["eslint", "tsc", "node_tests", "node_audit"],
  go: ["go_vet", "gofmt", "go_test", "govulncheck"],
  java_maven: ["maven_test"],
  csharp: ["dotnet_build", "dotnet_format", "dotnet_test", "dotnet_vulnerable"],
  rust: ["clippy", "rustfmt", "cargo_test", "cargo_audit"],
  ruby_rails: ["rubocop", "rspec", "bundler_audit", "brakeman"],
  php: ["phpstan", "phpunit", "composer_audit"],
  swift: ["swift_format", "swift_test"],
  cpp: ["cppcheck", "clang_format", "ctest"],
  solidity: ["forge_fmt", "forge_test"],
  dart_pkg: ["dart_analyze", "dart_format", "dart_test", "dart_pub_audit"],
  flutter_app: ["dart_analyze", "dart_format", "dart_test", "dart_pub_audit"],
  py_docker: ["ruff_check", "ruff_format", "pyrefly", "pyspector", "checkov_dockerfile"],
};

let FIXTURES: string;

beforeAll(() => {
  FIXTURES = mkdtempSync(join(tmpdir(), "satori-recommend-"));
  for (const [name, files] of Object.entries(REPOS)) {
    for (const [rel, content] of Object.entries(files)) {
      const path = join(FIXTURES, name, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
  }
});

afterEach(() => recommend.setRules(undefined));

const rec = (name: string, prefs: Record<string, unknown> | null = null) =>
  recommend.build(recommend.detect(join(FIXTURES, name)), prefs);
const ids = (r: recommend.Recommendation) => new Set(r.checks.map((c) => c.id));

describe.each(Object.keys(EXPECTED_IDS))("%s", (name) => {
  it("recommends the expected checks as a well-formed playbook", () => {
    const r = rec(name);
    expect(ids(r)).toEqual(new Set(EXPECTED_IDS[name]));
    const playbook = parse(r.yaml);
    expect(playbook).toEqual(r.playbook);
    expect(r.yaml.startsWith("# satori:recommended v")).toBe(true);
    for (const check of r.checks) {
      expect(playbook[check.category][check.id].run).toEqual([check.command]);
    }
  });
});

it("rules use only the closed vocabulary", () => {
  recommend.validateRules(recommend.loadRules());
});

it("every rule renders a command for each manager of its language", () => {
  const rules = recommend.loadRules();
  for (const tool of rules.tools) {
    const language = tool.language === "dockerfile" ? "python" : tool.language;
    for (const manager of Object.keys(rules.profiles[language])) {
      const profile = new recommend.Profile(FIXTURES, language, manager, { pyproject: "x" });
      const install: string[] = [];
      const command = recommend.renderCommand(profile, rules, tool, install);
      if (command === null) continue;
      expect(command).not.toMatch(/\{(pm|package|version)\}/);
      for (const step of install) expect(step).not.toMatch(/\{(package|version)\}/);
    }
  }
});

it("existing black config means no formatter question", () => {
  const r = rec("py_black");
  expect(r.prefsUsed.formatter).toBe("black");
  expect(r.questions.map((q) => q.pref)).not.toContain("formatter");
  expect(ids(r)).toContain("black_check");
  expect(ids(r)).not.toContain("ruff_format");
  expect(r.checks.filter((c) => c.blocking).map((c) => c.id)).toEqual(["black_check"]);
});

it("unconfigured optional tools are asked with defaults", () => {
  const r = rec("py_docker");
  expect(new Set(r.questions.map((q) => q.pref))).toEqual(new Set(["formatter", "dead_code", "types", "security"]));
  expect(r.prefsUsed).toEqual({ formatter: "ruff", dead_code: false, types: true, security: true });
  expect(ids(r)).not.toContain("vulture");
});

it("explicit prefs are applied and persisted in the header", () => {
  const r = rec("py_docker", { formatter: "black", dead_code: "true" });
  expect(ids(r)).toContain("black_check");
  expect(ids(r)).toContain("vulture");
  expect(ids(r)).not.toContain("ruff_format");
  expect(r.header).toBe("# satori:recommended v3 python/uv prefs: formatter=black dead_code=true");
  expect(new Set(r.questions.map((q) => q.pref))).toEqual(new Set(["types", "security"]));
});

it.each([{ formatter: "yapf" }, { nope: true }, { dead_code: "maybe" }])("rejects invalid prefs %j", (prefs) => {
  expect(() => rec("py_docker", prefs)).toThrow(SatoriError);
});

it("header round-trips", () => {
  expect(
    recommend.parseHeader("# satori:recommended v3 python/uv prefs: formatter=black dead_code=false\nx: 1\n"),
  ).toEqual([3, { formatter: "black", dead_code: "false" }]);
  expect(recommend.parseHeader("# satori:recommended v2 go/go\n")).toEqual([2, {}]);
  expect(recommend.parseHeader("settings: {}\n")).toBeNull();
});

it("an update asks only about tools newer than the header", () => {
  const rules = recommend.loadRules();
  const previous: [number, Record<string, string>] = [1, { formatter: "black", dead_code: "false" }];
  const profile = recommend.detect(join(FIXTURES, "py_updated"));
  expect(recommend.build(profile, null, previous).questions).toEqual([]);

  recommend.setRules({
    ...rules,
    rules_version: 2,
    tools: rules.tools.map((t: any) => (t.id === "pyrefly" ? { ...t, since: 2 } : t)),
  });
  const r = recommend.build(profile, null, previous);
  expect(r.questions.map((q) => q.pref)).toEqual(["types"]);
  expect(r.header.startsWith("# satori:recommended v2 python/uv")).toBe(true);
});

it("diffExisting reports missing checks and keeps present ones", () => {
  const root = join(FIXTURES, "py_updated");
  const llm = readFileSync(join(root, recommend.LLM_PLAYBOOK), "utf-8");
  const r = recommend.build(recommend.detect(root), null, recommend.parseHeader(llm));
  const changes = recommend.diffExisting(llm, r);
  const missing = new Set(changes.missing.map((c: any) => c.id));
  expect(missing).not.toContain("ruff_check");
  expect(missing).toContain("black_check");
  expect(missing).toContain("pyspector");
  expect(changes.up_to_date).toBe(false);
  expect(changes.missing[0].suggested_yaml).toContain("run:");
});

it("CI importer helpers", () => {
  expect(recommend.ciImporterYaml()).toBe("import:\n- file://.satori-llm.yml\n");
  const withInstall = recommend.ciImporterYaml(["uv sync --all-groups"]);
  expect(withInstall).toBe("install:\n- uv sync --all-groups\nimport:\n- file://.satori-llm.yml\n");
  const withName = recommend.ciImporterYaml(["uv sync"], "demo-app");
  expect(withName).toBe(
    "settings:\n  name: demo-app\ninstall:\n- uv sync\nimport:\n- file://.satori-llm.yml\n",
  );
  expect(recommend.ciImportsLlm(withInstall)).toBe(true);
  expect(recommend.ciImportsLlm("import:\n  - file://.satori-llm.yml\n")).toBe(true);
  expect(recommend.ciImportsLlm("settings:\n  name: x\n")).toBe(false);
  expect(recommend.ciImportsLlm("import:\n  - satori://secrets/semgrep.yml\n")).toBe(false);
  expect(recommend.hasRecommendedHeader("# satori:recommended v1 python/uv\nx: 1\n")).toBe(true);
  expect(recommend.hasRecommendedHeader("settings: {}\n")).toBe(false);
  expect(recommend.ciInstallMissing("install:\n- uv sync --all-groups\n", ["uv sync --all-groups", "extra"])).toEqual([
    "extra",
  ]);
});

it("projectName uses manifest, sanitizes scopes, falls back to folder", () => {
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "node_pnpm")))).toBe("demo-app");
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "py_uv")))).toBe("d");
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "node_scoped")))).toBe("widgets");
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "go")))).toBe("widget");
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "rust")))).toBe("x");
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "dart_pkg")))).toBe("example");
  // No package.json name → directory basename
  expect(recommend.projectName(recommend.detect(join(FIXTURES, "node_npm_nolock")))).toBe("node_npm_nolock");
  // Empty root label → omit
  expect(recommend.projectName(new recommend.Profile(".", "node", "npm"))).toBeNull();
});

it("LLM and CI playbooks use project-derived settings.name", () => {
  const r = rec("node_pnpm");
  expect(r.playbook.settings.name).toBe("demo-app quality");
  expect(r.playbook.settings.image).toBeTruthy();
  expect(parse(r.yaml).settings.name).toBe("demo-app quality");
});

it("LLM playbook omits install; recommendation still lists it", () => {
  const r = rec("py_uv");
  expect(r.install).toEqual(["uv sync --all-groups"]);
  expect(r.playbook.install).toBeUndefined();
  expect(parse(r.yaml).install).toBeUndefined();
});

it("diffExisting reports move_install_to_ci and not install_missing", () => {
  const root = join(FIXTURES, "py_updated");
  const llm =
    "# satori:recommended v1 python/uv prefs: formatter=black dead_code=false\n" +
    "settings:\n  name: mine\ninstall:\n- uv sync --all-groups\nlint:\n  ruff_check:\n    run:\n" +
    "    - uvx --from ruff==0.17.0 ruff check --output-format=json .\n";
  const r = recommend.build(recommend.detect(root), null, recommend.parseHeader(llm));
  const changes = recommend.diffExisting(llm, r);
  expect(changes.move_install_to_ci).toEqual(["uv sync --all-groups"]);
  expect(changes).not.toHaveProperty("install_missing");
  expect(changes.up_to_date).toBe(false);
});

it("no supported project is an error", () => {
  const empty = mkdtempSync(join(tmpdir(), "satori-empty-"));
  expect(() => recommend.detect(empty)).toThrow(/No supported project/);
});

it("node without a lockfile uses a plain install", () => {
  const r = rec("node_npm_nolock");
  expect(r.install).toEqual(["npm install"]);
  expect(ids(r)).not.toContain("node_tests");
});

it("on-demand tools are installed without the project prefix", () => {
  const r = rec("ruby_rails");
  expect(r.install[0]).toBe("bundle install");
  expect(r.install).toEqual(expect.arrayContaining(["gem install bundler-audit -v 0.9.3", "gem install brakeman -v 8.1.0"]));
  const commands = Object.fromEntries(r.checks.map((c) => [c.id, c.command]));
  expect(commands.brakeman).toBe("brakeman -q -f json");
  expect(commands.rubocop).toBe("bundle exec rubocop --format json");
});

it("foundry wins over package.json", () => {
  const profile = recommend.detect(join(FIXTURES, "solidity"));
  expect([profile.language, profile.manager]).toEqual(["solidity", "foundry"]);
  expect(profile.otherLanguages).toEqual(["node"]);
});

it("detects pure Dart vs Flutter managers", () => {
  expect(recommend.detect(join(FIXTURES, "dart_pkg")).manager).toBe("dart");
  const flutter = recommend.detect(join(FIXTURES, "flutter_app"));
  expect([flutter.language, flutter.manager]).toEqual(["dart", "flutter"]);
  expect(flutter.hasDep("flutter_lints")).toBe(true);
  const r = rec("flutter_app");
  expect(r.checks.filter((c) => c.blocking).map((c) => c.id)).toContain("dart_analyze");
  expect(Object.fromEntries(r.checks.map((c) => [c.id, c.command]))).toMatchObject({
    dart_analyze: "flutter analyze",
    dart_test: "flutter test",
  });
  expect(Object.fromEntries(rec("dart_pkg").checks.map((c) => [c.id, c.command]))).toMatchObject({
    dart_analyze: "dart analyze",
    dart_test: "dart test",
  });
});

describe("recommend_playbook tool", () => {
  it("returns a new playbook, or changes for an existing one", async () => {
    const result = await recommendPlaybook({ directory: join(FIXTURES, "py_uv") });
    expect(result.language).toBe("python");
    expect(result).toHaveProperty("playbook_yaml");
    expect(result).not.toHaveProperty("changes");
    expect(result.playbook_yaml).not.toContain("\ninstall:");
    expect(result.ci_playbook_yaml).toContain(recommend.LLM_IMPORT);
    expect(result.ci_playbook_yaml).toContain("uv sync --all-groups");
    expect(result.ci_playbook_yaml).toContain("name: d");
    expect(result.playbook_yaml).toContain("name: d quality");
    expect(result.hint).toContain(recommend.LLM_PLAYBOOK);
    expect(result.hint).toContain(recommend.CI_PLAYBOOK);
    expect(result.hint).toContain("run_local(playbook_path='.satori-llm.yml')");
    expect(result.llm_playbook).toBe(recommend.LLM_PLAYBOOK);

    const existing = await recommendPlaybook({ directory: join(FIXTURES, "py_updated") });
    expect(existing.existing).toBe(true);
    expect(existing).not.toHaveProperty("playbook_yaml");
    expect(existing.header.startsWith("# satori:recommended v3")).toBe(true);
    expect(existing).not.toHaveProperty("needs_ci_import");
    expect(existing).not.toHaveProperty("migrate_from_ci");
    expect(existing.ci_install_missing).toEqual(["uv sync --all-groups"]);
    expect(existing.hint).toContain(recommend.LLM_PLAYBOOK);

    expect((await recommendPlaybook({ directory: join(FIXTURES, "nope") })).error).toContain("existing directory");
    const empty = mkdtempSync(join(tmpdir(), "satori-empty-"));
    expect((await recommendPlaybook({ directory: empty })).error).toContain("No supported project");
  });

  it("migrates a legacy recommended .satori.yml", async () => {
    const result = await recommendPlaybook({ directory: join(FIXTURES, "py_legacy_ci") });
    expect(result.existing).toBe(true);
    expect(result.migrate_from_ci).toBe(true);
    expect(result.needs_ci_import).toBe(true);
    expect(result.ci_import_yaml).toBe("import:\n- file://.satori-llm.yml\n");
    expect(result.ci_install_missing).toEqual(["uv sync --all-groups"]);
    expect(result.hint).toContain("Move the recommended content");
    expect(result).not.toHaveProperty("playbook_yaml");
  });

  it("suggests an import for a CI-only repo without diffing CI", async () => {
    const result = await recommendPlaybook({ directory: join(FIXTURES, "py_ci_only") });
    expect(result).toHaveProperty("playbook_yaml");
    expect(result.playbook_yaml).not.toContain("\ninstall:");
    expect(result).not.toHaveProperty("changes");
    expect(result.needs_ci_import).toBe(true);
    expect(result.ci_import_yaml).toBe("import:\n- file://.satori-llm.yml\n");
    expect(result.ci_install_missing).toEqual(["uv sync --all-groups"]);
    expect(result.hint).toContain("do not overwrite");
    expect(result.hint).toContain("ci_install_missing");
    expect(result.hint).toContain(recommend.LLM_PLAYBOOK);
  });

  it("hints at the CI import for an existing LLM playbook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "satori-ci-"));
    writeFileSync(join(dir, "pyproject.toml"), '[project]\nname = "x"\nrequires-python = ">=3.10"\n');
    writeFileSync(
      join(dir, ".satori-llm.yml"),
      "# satori:recommended v2 python/uv\nsettings:\n  name: x\ntest:\n  assertReturnCode: 0\n",
    );
    writeFileSync(join(dir, ".satori.yml"), "settings:\n  name: ci\ntest:\n  assertReturnCode: 0\n");
    const result = await recommendPlaybook({ directory: dir });
    expect(result.existing).toBe(true);
    expect(result.hint).toContain(".satori-llm.yml");
    expect(result.needs_ci_import).toBe(true);
  });
});
