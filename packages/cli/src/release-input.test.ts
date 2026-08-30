import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../..");
const verifier = resolve(repo, "scripts/verify-release-input.mjs");

/** The ambient env with every workflow-projected release input cleared. The
 * publish workflow itself runs this suite in its deterministic gates, so a
 * live `SKIP_CUSTOM_ED25519_INPUT=true` (or any other projected input) would
 * otherwise leak into cases that assert a DIFFERENT input combination — the
 * suite must pin the whole surface it is testing, never inherit it. */
function baseEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "RELEASE_MODE_INPUT",
    "RELEASE_REF_INPUT",
    "REVIEW_ATTESTATION_B64_INPUT",
    "WAIVE_CURSOR_REVIEW_INPUT",
    "RUNTIME_MANIFEST_B64_INPUT",
    "REMOTE_RUNTIME_MANIFEST_B64_INPUT",
    "SKIP_CUSTOM_ED25519_INPUT",
    "CANDIDATE_RUN_ID_INPUT",
    "GITHUB_SHA",
    "GITHUB_REF",
  ]) {
    delete env[key];
  }
  return env;
}

function head(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
}

type PublishFixture = {
  candidateSha: string;
  fixture: string;
  tag: string;
};

function withPublishFixture(version: string, run: (fixture: PublishFixture) => void): void {
  const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: fixture,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    });
  const tag = `v${version}`;
  try {
    git("init", "-q");
    writeFileSync(resolve(fixture, "package.json"), `${JSON.stringify({ version })}\n`);
    git("add", "package.json");
    git("commit", "-qm", "fixture");
    git("tag", "-a", tag, "-m", "fixture");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixture,
      encoding: "utf8",
    }).trim();
    run({ candidateSha, fixture, tag });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function verifyPublish(
  fixture: PublishFixture,
  overrides: NodeJS.ProcessEnv = {},
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [verifier], {
    cwd: fixture.fixture,
    encoding: "utf8",
    env: {
      ...baseEnv(),
      GITHUB_SHA: fixture.candidateSha,
      GITHUB_REF: `refs/tags/${fixture.tag}`,
      RELEASE_MODE_INPUT: "publish",
      RELEASE_REF_INPUT: fixture.tag,
      REVIEW_ATTESTATION_B64_INPUT: "",
      WAIVE_CURSOR_REVIEW_INPUT: "false",
      RUNTIME_MANIFEST_B64_INPUT: "",
      REMOTE_RUNTIME_MANIFEST_B64_INPUT: "",
      SKIP_CUSTOM_ED25519_INPUT: "false",
      ...overrides,
    },
  });
}

describe("candidate release input", () => {
  it("accepts only the exact workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: candidateSha,
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`release input OK: candidate ${candidateSha}`);
  });

  it("rejects a resolvable candidate that differs from the workflow-dispatch SHA", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: "0".repeat(40),
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release input rejected: candidate SHA does not match the workflow-dispatch GITHUB_SHA",
    );
  });

  it("rejects a publish tag when its commit differs from the workflow-dispatch SHA", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(resolve(fixture, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      git("tag", "-a", "v2.0.0", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/main", "HEAD");

      const result = spawnSync(process.execPath, [verifier], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          GITHUB_SHA: "0".repeat(40),
          GITHUB_REF: "refs/tags/v2.0.0",
          RELEASE_MODE_INPUT: "publish",
          RELEASE_REF_INPUT: "v2.0.0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish SHA does not match the workflow-dispatch GITHUB_SHA",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("rejects publish from a branch ref before release work can start", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "claudexor-release-input-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: fixture,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.invalid",
          GIT_COMMITTER_NAME: "fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
      });
    try {
      git("init", "-q");
      writeFileSync(resolve(fixture, "README.md"), "fixture\n");
      git("add", "README.md");
      git("commit", "-qm", "fixture");
      git("tag", "-a", "v2.0.0", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      const candidateSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture,
        encoding: "utf8",
      }).trim();

      const result = spawnSync(process.execPath, [verifier], {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...baseEnv(),
          GITHUB_SHA: candidateSha,
          GITHUB_REF: "refs/heads/main",
          RELEASE_MODE_INPUT: "publish",
          RELEASE_REF_INPUT: "v2.0.0",
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish workflow must be dispatched from the exact release tag ref",
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("one-release custom Ed25519 waiver", () => {
  it("rejects a non-boolean waiver value", () => {
    withPublishFixture("3.8.0", (fixture) => {
      const result = verifyPublish(fixture, { SKIP_CUSTOM_ED25519_INPUT: "1" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: skip_custom_ed25519 must be a boolean workflow input",
      );
    });
  });

  it.each(["3.8.0", "3.9.0"])(
    "accepts an exact v%s publish with all three custom inputs empty",
    (version) => {
      withPublishFixture(version, (fixture) => {
        const reviewPath = resolve(fixture.fixture, "review-attestation.json");
        const result = verifyPublish(fixture, {
          REVIEW_ATTESTATION_PATH: reviewPath,
          SKIP_CUSTOM_ED25519_INPUT: "true",
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`release input OK: publish ${fixture.candidateSha}`);
        expect(existsSync(reviewPath)).toBe(false);
      });
    },
  );

  it("keeps the normal publish path fail-closed when the review attestation is empty", () => {
    withPublishFixture("3.8.0", (fixture) => {
      const result = verifyPublish(fixture);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish mode requires a base64-encoded review attestation",
      );
    });
  });

  it.each(["3.3.17", "3.8.4", "3.9.1"])(
    "rejects the waiver for every package version outside the exact 3.8.0/3.9.0 list (%s)",
    (version) => {
      withPublishFixture(version, (fixture) => {
        const result = verifyPublish(fixture, { SKIP_CUSTOM_ED25519_INPUT: "true" });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "release input rejected: skip_custom_ed25519 is authorized only for package versions 3.8.0 and 3.9.0",
        );
      });
    },
  );

  it.each([
    "REVIEW_ATTESTATION_B64_INPUT",
    "RUNTIME_MANIFEST_B64_INPUT",
    "REMOTE_RUNTIME_MANIFEST_B64_INPUT",
  ])("rejects the waiver when %s is nonempty", (inputName) => {
    withPublishFixture("3.8.0", (fixture) => {
      const result = verifyPublish(fixture, {
        [inputName]: "e30=",
        SKIP_CUSTOM_ED25519_INPUT: "true",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: skip_custom_ed25519 requires review_attestation_b64, runtime_manifest_b64, and remote_runtime_manifest_b64 to all be empty",
      );
    });
  });

  it("rejects the waiver in candidate mode", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier, "--syntax-only"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: candidateSha,
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
        REVIEW_ATTESTATION_B64_INPUT: "",
        RUNTIME_MANIFEST_B64_INPUT: "",
        REMOTE_RUNTIME_MANIFEST_B64_INPUT: "",
        SKIP_CUSTOM_ED25519_INPUT: "true",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release input rejected: skip_custom_ed25519 is allowed only in publish mode",
    );
  });
});

describe("version-scoped Cursor review waiver", () => {
  const signedRuntimeInputs = {
    RUNTIME_MANIFEST_B64_INPUT: "e30=",
    REMOTE_RUNTIME_MANIFEST_B64_INPUT: "e30=",
    WAIVE_CURSOR_REVIEW_INPUT: "true",
  };

  it.each(["3.8.1", "3.8.2", "3.9.1"])(
    "accepts v%s with an empty review attestation and both runtime inputs",
    (version) => {
      withPublishFixture(version, (fixture) => {
        const reviewPath = resolve(fixture.fixture, "review-attestation.json");
        const outputPath = resolve(fixture.fixture, "github-output");
        const result = verifyPublish(fixture, {
          ...signedRuntimeInputs,
          REVIEW_ATTESTATION_PATH: reviewPath,
          GITHUB_OUTPUT: outputPath,
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(`release input OK: publish ${fixture.candidateSha}`);
        expect(readFileSync(outputPath, "utf8")).toContain("waive_cursor_review=true");
        expect(existsSync(reviewPath)).toBe(false);
      });
    },
  );

  it("keeps the normal v3.8.2 publish path fail-closed when review is empty", () => {
    withPublishFixture("3.8.2", (fixture) => {
      const reviewPath = resolve(fixture.fixture, "review-attestation.json");
      const result = verifyPublish(fixture, {
        REVIEW_ATTESTATION_PATH: reviewPath,
        RUNTIME_MANIFEST_B64_INPUT: "e30=",
        REMOTE_RUNTIME_MANIFEST_B64_INPUT: "e30=",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish mode requires a base64-encoded review attestation",
      );
      expect(existsSync(reviewPath)).toBe(false);
    });
  });

  it("keeps the normal v3.8.1 publish path fail-closed when review is empty", () => {
    withPublishFixture("3.8.1", (fixture) => {
      const result = verifyPublish(fixture, {
        RUNTIME_MANIFEST_B64_INPUT: "e30=",
        REMOTE_RUNTIME_MANIFEST_B64_INPUT: "e30=",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: publish mode requires a base64-encoded review attestation",
      );
    });
  });

  it("rejects a non-boolean waiver value", () => {
    withPublishFixture("3.8.1", (fixture) => {
      const result = verifyPublish(fixture, {
        ...signedRuntimeInputs,
        WAIVE_CURSOR_REVIEW_INPUT: "1",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: waive_cursor_review must be a boolean workflow input",
      );
    });
  });

  it.each(["3.8.0", "3.8.3"])("rejects the waiver for package version %s", (version) => {
    withPublishFixture(version, (fixture) => {
      const result = verifyPublish(fixture, signedRuntimeInputs);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: waive_cursor_review is authorized only for package versions 3.8.1, 3.8.2, and 3.9.1",
      );
    });
  });

  it("rejects the waiver in candidate mode", () => {
    const candidateSha = head();
    const result = spawnSync(process.execPath, [verifier, "--syntax-only"], {
      cwd: repo,
      encoding: "utf8",
      env: {
        ...baseEnv(),
        GITHUB_SHA: candidateSha,
        RELEASE_MODE_INPUT: "candidate",
        RELEASE_REF_INPUT: candidateSha,
        WAIVE_CURSOR_REVIEW_INPUT: "true",
        RUNTIME_MANIFEST_B64_INPUT: "e30=",
        REMOTE_RUNTIME_MANIFEST_B64_INPUT: "e30=",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "release input rejected: waive_cursor_review is allowed only in publish mode",
    );
  });

  it("rejects a nonempty review attestation", () => {
    withPublishFixture("3.8.1", (fixture) => {
      const result = verifyPublish(fixture, {
        ...signedRuntimeInputs,
        REVIEW_ATTESTATION_B64_INPUT: "e30=",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: waive_cursor_review requires review_attestation_b64 to be empty",
      );
    });
  });

  it.each(["RUNTIME_MANIFEST_B64_INPUT", "REMOTE_RUNTIME_MANIFEST_B64_INPUT"])(
    "rejects the waiver when %s is missing",
    (inputName) => {
      withPublishFixture("3.8.1", (fixture) => {
        const inputs = { ...signedRuntimeInputs };
        delete inputs[inputName as keyof typeof inputs];
        const result = verifyPublish(fixture, inputs);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "release input rejected: waive_cursor_review still requires runtime_manifest_b64 and remote_runtime_manifest_b64",
        );
      });
    },
  );

  it("rejects a non-base64 runtime manifest", () => {
    withPublishFixture("3.8.1", (fixture) => {
      const result = verifyPublish(fixture, {
        ...signedRuntimeInputs,
        RUNTIME_MANIFEST_B64_INPUT: "not base64",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: waive_cursor_review requires base64-encoded runtime manifests",
      );
    });
  });

  it("rejects combining the review waiver with the v3.8.0 custom waiver", () => {
    withPublishFixture("3.8.1", (fixture) => {
      const result = verifyPublish(fixture, {
        ...signedRuntimeInputs,
        SKIP_CUSTOM_ED25519_INPUT: "true",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "release input rejected: waive_cursor_review cannot be combined with skip_custom_ed25519",
      );
    });
  });
});
