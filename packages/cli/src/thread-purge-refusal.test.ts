/**
 * #333 review C1/C2 through the real purge owner: the project removal receipt,
 * the purge obligation and the startup replay, over a real SQL store and real
 * Git. A lane parent linking out to the user's project, a held ref lock, a
 * locked worktree and a repository moved without a relink each keep the
 * thread's cleanup pending without deleting any user file or forgetting what
 * Git still records; once the cause is gone, the replay completes.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPartition,
  createSqlDaemonServices,
  EngineStore,
  setGlobalGenerationInTx,
} from "@claudexor/daemon";
import { projectRuntimeDir } from "@claudexor/util";
import { ensureThreadWorktree, git } from "@claudexor/workspace";
import { projectRemovalService } from "./project-removal.js";
import { sqlActivityRecords } from "./sql-daemon-queries.js";
import { threadPurgeEffect, threadPurgeOwner } from "./thread-purge.js";

let root: string;
let store: EngineStore;
let graph: ReturnType<typeof createSqlDaemonServices>;

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cx-purge-refusal-")));
  vi.stubEnv("CLAUDEXOR_CONFIG_DIR", join(root, "config"));
  store = await EngineStore.open({
    daemonDir: join(root, "daemon"),
    workerEntry: resolve(import.meta.dirname, "../../daemon/dist/store/flusher-worker.js"),
  });
  store.transaction(() => setGlobalGenerationInTx(store, createPartition(store, "global").pid));
  graph = createSqlDaemonServices(store, {
    purgeFiles: threadPurgeEffect(join(root, "no-project")),
  });
});

afterEach(async () => {
  await graph.close();
  await store.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function removeWithTrashedThreads(projectId: string) {
  const owner = threadPurgeOwner(graph.threads, join(root, "no-project"), graph.purgeFiles);
  return projectRemovalService(
    graph.threads,
    () => sqlActivityRecords(store),
    owner.finishPurge,
  )(projectId, { trashedThreads: "purge" });
}

function userProject(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "USER-SENTINEL"), "user data must remain");
  return graph.threads.registerProject({ root: dir, clientId: "test", idempotencyKey: dir })
    .project;
}

async function isolatedThread(projectRoot: string) {
  const thread = graph.threads.createThread({ repoRoot: projectRoot, workspace: "isolated" });
  const tree = await ensureThreadWorktree(projectRoot, thread.id);
  graph.threads.setThreadWorktree(thread.id, tree.path, tree.baseSha);
  writeFileSync(join(tree.path, "UNMERGED"), "thread-owned change");
  return { thread, tree, branch: `claudexor/thread-${thread.id}` };
}

const branchExists = async (repo: string, branch: string): Promise<boolean> =>
  (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
const registrations = async (repo: string): Promise<string> =>
  (await git(repo, ["worktree", "list", "--porcelain"])).stdout;
const sentinel = (dir: string): string => readFileSync(join(dir, "USER-SENTINEL"), "utf8");
const openPurges = () =>
  graph.obligations.open().map((row) => ({ kind: row.kind, key: row.key, state: row.state }));

/** Startup replay of the open purge obligations. */
async function replay() {
  const receipt = await graph.recoverAfterStartup();
  await store.flushed();
  return receipt;
}

describe("purge cleanup refusals stay pending (#333 review C1, C2)", () => {
  it("refuses a lane parent that links to the user's project instead of deleting it", async () => {
    const initial = userProject(join(root, "initial-user-project"));
    const thread = graph.threads.createThread({ repoRoot: initial.root });
    // A folder move plus the public relink give the project the thread's name.
    const userRoot = join(root, thread.id);
    renameSync(initial.root, userRoot);
    const project = graph.threads.relinkProject(initial.id, userRoot);
    graph.threads.trashThread(thread.id);
    const runtime = projectRuntimeDir(userRoot);
    mkdirSync(runtime, { recursive: true });
    symlinkSync(root, join(runtime, "lanes"), "dir");
    expect(realpathSync(join(runtime, "lanes", thread.id))).toBe(userRoot);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("refusing to follow"),
      },
    ]);
    expect(sentinel(userRoot)).toBe("user data must remain");
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);

    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);
    expect(sentinel(userRoot)).toBe("user data must remain");
    unlinkSync(join(runtime, "lanes"));
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(openPurges()).toEqual([]);
    expect(sentinel(userRoot)).toBe("user data must remain");
  });

  it("keeps a branch held by a ref lock pending until the lock is released", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    const lock = join(project.root, ".git", "refs", "heads", `${branch}.lock`);
    writeFileSync(lock, "held by a concurrent git process");
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git branch -D"),
      },
    ]);
    expect(await branchExists(project.root, branch)).toBe(true);
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);

    rmSync(lock);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await branchExists(project.root, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("keeps a locked worktree, its registration and branch pending until it is unlocked", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    expect((await git(project.root, ["worktree", "lock", tree.path])).code).toBe(0);
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git worktree remove failed"),
      },
    ]);
    expect(readFileSync(join(tree.path, "UNMERGED"), "utf8")).toBe("thread-owned change");
    expect(await registrations(project.root)).toContain(realpathSync(tree.path));
    expect(await branchExists(project.root, branch)).toBe(true);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);
    expect(existsSync(tree.path)).toBe(true);

    expect((await git(project.root, ["worktree", "unlock", tree.path])).code).toBe(0);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await registrations(project.root)).not.toContain(thread.id);
    expect(await branchExists(project.root, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("completes an ordinary purge and one whose worktree and branch are already gone", async () => {
    const project = userProject(join(root, "project"));
    const ordinary = await isolatedThread(project.root);
    const gone = await isolatedThread(project.root);
    expect((await git(project.root, ["worktree", "remove", "--force", gone.tree.path])).code).toBe(
      0,
    );
    expect((await git(project.root, ["branch", "-D", gone.branch])).code).toBe(0);
    const asked = graph.threads.createThread({ repoRoot: project.root });
    mkdirSync(join(projectRuntimeDir(project.root), "lanes", asked.id, "fake-default", "home"), {
      recursive: true,
    });
    for (const thread of [ordinary.thread, gone.thread, asked])
      graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads?.map((item) => item.cleanup)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    for (const { thread, tree, branch } of [ordinary, gone]) {
      expect(existsSync(dirname(tree.path))).toBe(false);
      expect(await branchExists(project.root, branch)).toBe(false);
      expect(await registrations(project.root)).not.toContain(thread.id);
    }
    expect(existsSync(join(projectRuntimeDir(project.root), "lanes", asked.id))).toBe(false);
    await store.flushed();
    expect(openPurges()).toEqual([]);
    expect(sentinel(project.root)).toBe("user data must remain");
  });

  it("keeps the cleanup pending when the repository moved without a relink, until Git repairs it", async () => {
    const project = userProject(join(root, "project"));
    const { thread, tree, branch } = await isolatedThread(project.root);
    graph.threads.trashThread(thread.id);
    const moved = join(root, "project-moved");
    renameSync(project.root, moved);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      {
        threadId: thread.id,
        cleanup: "pending",
        cleanupError: expect.stringContaining("git worktree repair"),
      },
    ]);
    // Nothing the moved repository still records is touched or forgotten.
    expect(await registrations(moved)).toContain(realpathSync(tree.path));
    expect(await branchExists(moved, branch)).toBe(true);
    expect(readFileSync(join(tree.path, "UNMERGED"), "utf8")).toBe("thread-owned change");
    expect(openPurges()).toEqual([{ kind: "purge_fs", key: thread.id, state: "pending" }]);
    expect((await replay()).failed).toMatchObject([{ kind: "purge_fs", key: thread.id }]);

    // The disclosed recovery: Git repairs the worktree's link to the moved repository.
    expect((await git(moved, ["worktree", "repair"])).code).toBe(0);
    expect((await replay()).completed).toEqual([{ kind: "purge_fs", key: thread.id }]);
    expect(await registrations(moved)).not.toContain(thread.id);
    expect(await branchExists(moved, branch)).toBe(false);
    expect(existsSync(dirname(tree.path))).toBe(false);
    expect(openPurges()).toEqual([]);
    expect(sentinel(moved)).toBe("user data must remain");
  });

  it("completes an isolated thread that never had a worktree, outside any repository", async () => {
    const project = userProject(join(root, "plain"));
    const thread = graph.threads.createThread({ repoRoot: project.root, workspace: "isolated" });
    graph.threads.trashThread(thread.id);

    const receipt = await removeWithTrashedThreads(project.id);
    expect(receipt.purgedThreads).toEqual([
      { threadId: thread.id, cleanup: "completed", cleanupError: null },
    ]);
    await store.flushed();
    expect(openPurges()).toEqual([]);
    expect(existsSync(join(project.root, ".git"))).toBe(false);
  });
});
