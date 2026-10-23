import { z } from "zod";
import { encodePath } from "../client.js";
import {
  READ,
  bbqlString,
  external,
  fail,
  json,
  limitParam,
  ref as encodeRef,
  repoParam,
  repoPath,
  safe,
  slug,
  text,
  truncate,
  workspaceParam,
  type ToolContext,
} from "./shared.js";

interface BbRepository {
  slug: string;
  name: string;
  full_name: string;
  description?: string;
  is_private: boolean;
  updated_on: string;
  mainbranch?: { name: string };
  project?: { key: string; name: string };
}

interface BbBranch {
  name: string;
  target: { hash: string; date: string; message: string; author: { raw: string } };
}

interface BbCommit {
  hash: string;
  date: string;
  message: string;
  author: { raw: string };
}

/** El listado JSON que devuelve /src/ cuando el path es una carpeta. */
export function isDirectoryListing(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { pagelen?: unknown; values?: { type?: string }[] };
    return (
      typeof parsed.pagelen === "number" &&
      Array.isArray(parsed.values) &&
      parsed.values.every((v) => v.type === "commit_file" || v.type === "commit_directory")
    );
  } catch {
    return false;
  }
}

const refParam = z.string().optional().describe("Rama, tag o hash. Si se omite, la rama principal.");

export function registerRepoTools(ctx: ToolContext): void {
  const { server, client } = ctx;

  async function resolveRef(workspace: string | undefined, repo: string, ref?: string): Promise<string> {
    if (ref) return ref;
    const info = await client.get<BbRepository>(repoPath(client, workspace, repo));
    if (!info.mainbranch) throw new Error(`El repo ${repo} no tiene rama principal (¿está vacío?).`);
    return info.mainbranch.name;
  }

  async function branchHash(workspace: string | undefined, repo: string, branch: string): Promise<string> {
    const b = await client.get<BbBranch>(
      `${repoPath(client, workspace, repo)}/refs/branches/${encodeRef(branch)}`,
    );
    return b.target.hash;
  }

  server.registerTool(
    "list_repositories",
    {
      title: "Listar repositorios",
      description: "Repos del workspace, los actualizados más recientemente primero. query filtra por nombre.",
      inputSchema: { workspace: workspaceParam, query: z.string().optional(), limit: limitParam(30) },
      annotations: READ,
    },
    safe(async ({ workspace, query, limit }) => {
      const repos = await client.paginate<BbRepository>(
        `/repositories/${slug(client.workspace(workspace), "Workspace")}`,
        { sort: "-updated_on", q: query ? `name ~ ${bbqlString(query)}` : undefined },
        limit,
      );
      return json(
        repos.map((r) => ({
          slug: r.slug,
          name: r.name,
          project: r.project?.name,
          main_branch: r.mainbranch?.name,
          private: r.is_private,
          updated_on: r.updated_on,
        })),
      );
    }),
  );

  server.registerTool(
    "list_branches",
    {
      title: "Listar ramas",
      description: "Ramas del repo, las de commit más reciente primero. query filtra por nombre (ej. el ID del ticket).",
      inputSchema: { workspace: workspaceParam, repo: repoParam, query: z.string().optional(), limit: limitParam(30) },
      annotations: READ,
    },
    safe(async ({ workspace, repo, query, limit }) => {
      const branches = await client.paginate<BbBranch>(
        `${repoPath(client, workspace, repo)}/refs/branches`,
        { sort: "-target.date", q: query ? `name ~ ${bbqlString(query)}` : undefined },
        limit,
      );
      return json(
        branches.map((b) => ({
          name: b.name,
          last_commit: b.target.hash.slice(0, 12),
          date: b.target.date,
          author: b.target.author.raw,
          message: b.target.message.split("\n")[0],
        })),
      );
    }),
  );

  server.registerTool(
    "list_commits",
    {
      title: "Listar commits",
      description: "Commits de una rama (por defecto la principal), del más nuevo al más viejo.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, ref: refParam, limit: limitParam(20) },
      annotations: READ,
    },
    safe(async ({ workspace, repo, ref, limit }) => {
      const target = await resolveRef(workspace, repo, ref);
      const commits = await client.paginate<BbCommit>(
        `${repoPath(client, workspace, repo)}/commits/${encodeRef(target)}`,
        {},
        limit,
      );
      return json(
        commits.map((c) => ({
          hash: c.hash.slice(0, 12),
          date: c.date,
          author: c.author.raw,
          message: c.message.trim(),
        })),
      );
    }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "Listar carpeta",
      description: "Archivos y carpetas en un path del repo (vacío = raíz).",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        path: z.string().default(""),
        ref: refParam,
        limit: limitParam(100, 500),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, path, ref, limit }) => {
      const target = await resolveRef(workspace, repo, ref);
      const dir = encodePath(path);
      const entries = await client.paginate<{ path: string; type: string; size?: number }>(
        `${repoPath(client, workspace, repo)}/src/${encodeRef(target)}/${dir ? `${dir}/` : ""}`,
        {},
        limit,
      );
      return json(
        entries.map((e) => ({
          path: e.path,
          type: e.type === "commit_directory" ? "dir" : "file",
          size: e.size,
        })),
      );
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Leer archivo",
      description: "Contenido de un archivo del repo en una rama, tag o commit.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        path: z.string().min(1),
        ref: refParam,
        max_chars: z.number().int().min(1000).max(200_000).default(60_000),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, path, ref, max_chars }) => {
      const filePath = encodePath(path);
      const base = repoPath(client, workspace, repo);
      const target = await resolveRef(workspace, repo, ref);
      const content = await client.getText(`${base}/src/${encodeRef(target)}/${filePath}`);
      if (isDirectoryListing(content)) {
        return fail(`${JSON.stringify(path)} es una carpeta: usá list_directory.`);
      }
      return text(external(`${repo}:${path}@${target}`, truncate(content, max_chars)));
    }),
  );

  server.registerTool(
    "compare_branches",
    {
      title: "Comparar ramas",
      description:
        "Lo que source tiene y destination no (como se vería en un PR de source a destination): " +
        "archivos cambiados y, si stat_only=false, el diff.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        source: z.string().describe("Rama con los cambios (ej. feature/ABC-123_demo)."),
        destination: z.string().optional().describe("Rama base. Si se omite, la principal."),
        stat_only: z.boolean().default(true),
        max_chars: z.number().int().min(1000).max(200_000).default(40_000),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, source, destination, stat_only, max_chars }) => {
      const dest = await resolveRef(workspace, repo, destination);
      const [srcHash, destHash] = await Promise.all([
        branchHash(workspace, repo, source),
        branchHash(workspace, repo, dest),
      ]);
      const spec = `${srcHash}..${destHash}`;
      const base = repoPath(client, workspace, repo);
      const stat = await client.paginate<{
        status: string;
        lines_added: number;
        lines_removed: number;
        old?: { path: string } | null;
        new?: { path: string } | null;
      }>(`${base}/diffstat/${spec}`, { topic: true }, 500);
      const files = stat.map((s) => ({
        path: s.new?.path ?? s.old?.path,
        status: s.status,
        added: s.lines_added,
        removed: s.lines_removed,
      }));
      if (stat_only) return json({ source, destination: dest, files });
      const diff = await client.getText(`${base}/diff/${spec}`, { topic: true });
      const summary = JSON.stringify({ source, destination: dest, files }, null, 2);
      return text(`${summary}\n\n${external(`diff ${source} → ${dest}`, truncate(diff, max_chars))}`);
    }),
  );
}
