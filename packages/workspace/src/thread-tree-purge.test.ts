/**
 * The isolated-thread purge never reports as deleted what Git still records
 * (#333 review C2) and never follows a link out of the runtime tree (C1): a
 * Git refusal, a link above the thread directory or a repository it cannot
 * reach throws, keeping directory, registration and branch; what is already
 * gone counts as done.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectRuntimeDir } from "@claudexor/util";
import { git, worktreeRemoveRegistered } from "./git.js";
import { ensureThreadWorktree, purgeThreadWorktree } from "./thread-tree.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(dir);
  return dir;
}

async function userRepo(): Promise<string> {
  const repo = tempDir("claudexor-purge-repo-");
  await git(repo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "user file\n");
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "user.email=t@t.dev", "-c", "user.name=Test", "commit", "-qm", "init"]);
  return repo;
}

const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
const registrations = async (repo: string): Promise<string> =>
  (await git(repo, ["worktree", "list", "--porcelain"])).stdout;

describe("isolated thread purge", () => {
  it("keeps a locked worktree, its registration and branch, and finishes once unlocked", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-locked");
    writeFileSync(join(tree.path, "unapplied.txt"), "thread work\n");
    expect((await git(repo, ["worktree", "lock", tree.path])).code).toBe(0);

    await expect(purgeThreadWorktree(repo, "th-locked")).rejects.toThrow(
      /git worktree remove failed/,
    );
    expect(readFileSync(join(tree.path, "unapplied.txt"), "utf8")).toBe("thread work\n");
    expect(await registrations(repo)).toContain(realpathSync(tree.path));
    expect(await branchExists(repo, "claudexor/thread-th-locked")).toBe(true);

    expect((await git(repo, ["worktree", "unlock", tree.path])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-locked");
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(await registrations(repo)).not.toContain("th-locked");
    expect(await branchExists(repo, "claudexor/thread-th-locked")).toBe(false);
  });

  it("keeps the branch and the thread directory while a ref lock is held", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-reflock");
    const lock = join(repo, ".git", "refs", "heads", "claudexor", "thread-th-reflock.lock");
    writeFileSync(lock, "held by a concurrent git process\n");

    await expect(purgeThreadWorktree(repo, "th-reflock")).rejects.toThrow(/git branch -D/);
    expect(await branchExists(repo, "claudexor/thread-th-reflock")).toBe(true);
    expect(existsSync(dirname(tree.path))).toBe(true);

    rmSync(lock);
    await purgeThreadWorktree(repo, "th-reflock");
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(await branchExists(repo, "claudexor/thread-th-reflock")).toBe(false);
  });

  it("finds Git's registration when the config dir is spelled in another case", async (context) => {
    const config = tempDir("claudexor-purge-config-");
    const respelled = join(dirname(config), basename(config).toUpperCase());
    if (!existsSync(respelled)) context.skip(); // a case-sensitive filesystem
    vi.stubEnv("CLAUDEXOR_CONFIG_DIR", respelled);
    const repo = await userRepo();
    await ensureThreadWorktree(repo, "th-case");

    await purgeThreadWorktree(repo, "th-case");
    expect(await registrations(repo)).not.toContain("th-case");
    expect(await branchExists(repo, "claudexor/thread-th-case")).toBe(false);
  });

  it("drops a registration and branch left behind after the directory went", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-stale");
    rmSync(dirname(tree.path), { recursive: true, force: true });

    await purgeThreadWorktree(repo, "th-stale");
    expect(await registrations(repo)).not.toContain("th-stale");
    expect(await branchExists(repo, "claudexor/thread-th-stale")).toBe(false);
  });

  it("counts a worktree and branch that are already gone as done", async () => {
    const repo = await userRepo();
    const removed = await ensureThreadWorktree(repo, "th-removed");
    expect((await git(repo, ["worktree", "remove", "--force", removed.path])).code).toBe(0);
    expect((await git(repo, ["branch", "-D", "claudexor/thread-th-removed"])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-removed");
    expect(existsSync(dirname(removed.path))).toBe(false);
  });

  it("purges a thread that never had a worktree, also outside any repository", async () => {
    const plain = tempDir("claudexor-purge-plain-");
    const tree = join(projectRuntimeDir(plain), "threads", "th-synthetic", "tree");
    mkdirSync(tree, { recursive: true });

    await purgeThreadWorktree(plain, "th-synthetic", { worktreeRecorded: false });
    expect(existsSync(dirname(tree))).toBe(false);
  });

  it("stays pending when the project repository is gone, as a deletion looks like a move", async () => {
    const repo = await userRepo();
    const tree = await ensureThreadWorktree(repo, "th-orphan");
    rmSync(repo, { recursive: true, force: true });

    await expect(purgeThreadWorktree(repo, "th-orphan")).rejects.toThrow(/git worktree repair/);
    expect(existsSync(join(tree.path, ".git"))).toBe(true);

    // Without the worktree's own pointer, a recorded worktree is unprovable too.
    rmSync(dirname(tree.path), { recursive: true, force: true });
    await expect(purgeThreadWorktree(repo, "th-orphan")).rejects.toThrow(/cannot be checked/);
    const plain = tempDir("claudexor-purge-plain-");
    await expect(purgeThreadWorktree(plain, "th-recorded")).rejects.toThrow(/cannot be checked/);

    // The disclosed recovery after a real deletion: with the leftover worktree
    // directory gone, an empty repository at the project path lets it finish.
    mkdirSync(repo);
    expect((await git(repo, ["init", "-q"])).code).toBe(0);
    await purgeThreadWorktree(repo, "th-orphan");
  });

  // Neither character is allowed in a Windows file name.
  it.skipIf(process.platform === "win32")(
    "finds the registration of a runtime path with quotes, tabs and non-ASCII letters",
    async () => {
      // Git prints worktree paths raw in porcelain output; only lock reasons are quoted.
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(tempDir("claudexor-purge-cfg-"), 'q"uote\tПроект é'));
      const repo = await userRepo();
      const tree = await ensureThreadWorktree(repo, "th-unusual");

      await purgeThreadWorktree(repo, "th-unusual");
      expect(await registrations(repo)).not.toContain("th-unusual");
      expect(await branchExists(repo, "claudexor/thread-th-unusual")).toBe(false);
      expect(existsSync(dirname(tree.path))).toBe(false);
    },
  );

  // Neither character is allowed in a Windows file name.
  it.skipIf(process.platform === "win32")(
    "refuses a runtime path with a line break instead of missing its registration",
    async () => {
      vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(tempDir("claudexor-purge-cfg-"), "line\nbreak"));
      const repo = await userRepo();
      const tree = await ensureThreadWorktree(repo, "th-newline");
      // Without its branch, only the registration is left to find.
      expect((await git(tree.path, ["checkout", "-q", "--detach"])).code).toBe(0);
      expect((await git(repo, ["branch", "-D", "claudexor/thread-th-newline"])).code).toBe(0);

      await expect(purgeThreadWorktree(repo, "th-newline")).rejects.toThrow(/line break/);
      expect(await registrations(repo)).toContain("th-newline");
      expect(existsSync(join(tree.path, ".git"))).toBe(true);
    },
  );

  it("never matches a registration that differs only in letter case", async (context) => {
    const base = tempDir("claudexor-purge-case-");
    mkdirSync(join(base, "case", "tree"), { recursive: true });
    if (existsSync(join(base, "CASE"))) context.skip(); // a case-insensitive filesystem
    const repo = await userRepo();
    const other = join(base, "CASE", "tree");
    expect((await git(repo, ["worktree", "add", "-q", "--detach", other])).code).toBe(0);

    await worktreeRemoveRegistered(repo, join(base, "case", "tree"));
    expect(await registrations(repo)).toContain(other);
    expect(existsSync(join(other, "README.md"))).toBe(true);
  });

  it("still reaches a larger repository after the project subfolder in it was deleted", async () => {
    const repo = await userRepo();
    const project = join(repo, "packages", "app");
    mkdirSync(project, { recursive: true });
    const tree = await ensureThreadWorktree(project, "th-subfolder");
    rmSync(project, { recursive: true, force: true });

    await purgeThreadWorktree(project, "th-subfolder");
    expect(await registrations(repo)).not.toContain("th-subfolder");
    expect(await branchExists(repo, "claudexor/thread-th-subfolder")).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
  });

  it("refuses a threads directory that links out of the runtime tree", async () => {
    const repo = await userRepo();
    const user = tempDir("claudexor-purge-user-");
    mkdirSync(join(user, "th-linked"));
    writeFileSync(join(user, "th-linked", "SENTINEL"), "user data\n");
    mkdirSync(projectRuntimeDir(repo), { recursive: true });
    symlinkSync(user, join(projectRuntimeDir(repo), "threads"), "dir");

    await expect(purgeThreadWorktree(repo, "th-linked")).rejects.toThrow(
      /link; refusing to follow/,
    );
    expect(readFileSync(join(user, "th-linked", "SENTINEL"), "utf8")).toBe("user data\n");
  });

  it("unlinks a linked thread directory without handing it to Git", async () => {
    // The link leads to the user's own linked worktree of the same repository.
    const repo = await userRepo();
    const user = tempDir("claudexor-purge-user-");
    const feature = await git(repo, ["worktree", "add", "-q", "-b", "feature", join(user, "tree")]);
    expect(feature.code).toBe(0);
    writeFileSync(join(user, "tree", "uncommitted.txt"), "user work\n");
    const threads = join(projectRuntimeDir(repo), "threads");
    mkdirSync(threads, { recursive: true });
    symlinkSync(user, join(threads, "th-final"), "dir");

    await purgeThreadWorktree(repo, "th-final");
    expect(lstatSync(join(threads, "th-final"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(user, "tree", "uncommitted.txt"), "utf8")).toBe("user work\n");
    expect(await registrations(repo)).toContain(join(user, "tree"));
    expect(await branchExists(repo, "feature")).toBe(true);
  });
});
