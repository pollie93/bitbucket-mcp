import { z } from "zod";
import {
  DESTRUCTIVE,
  READ,
  WRITE,
  critical,
  external,
  fail,
  json,
  limitParam,
  repoParam,
  repoPath,
  safe,
  slug,
  text,
  truncate,
  userSummary,
  workspaceParam,
  type BbUser,
  type ToolContext,
} from "./shared.js";

interface BbParticipant {
  user: BbUser;
  role: "PARTICIPANT" | "REVIEWER";
  approved: boolean;
  state: "approved" | "changes_requested" | null;
}

export interface BbPullRequest {
  id: number;
  title: string;
  description?: string;
  state: string;
  author: BbUser;
  source: { branch: { name: string }; repository?: { full_name: string } };
  destination: { branch: { name: string } };
  reviewers?: BbUser[];
  participants?: BbParticipant[];
  comment_count?: number;
  task_count?: number;
  close_source_branch?: boolean;
  created_on: string;
  updated_on: string;
  links: { html: { href: string } };
}

interface BbComment {
  id: number;
  content: { raw: string };
  user: BbUser;
  created_on: string;
  deleted?: boolean;
  inline?: { path: string; from?: number | null; to?: number | null };
  parent?: { id: number };
  resolution?: unknown;
}

const prState = z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
const prId = z.number().int().positive().describe("Número del pull request.");

export function summarizePullRequest(pr: BbPullRequest) {
  return {
    id: pr.id,
    title: pr.title,
    state: pr.state,
    author: pr.author.display_name,
    source: pr.source.branch.name,
    destination: pr.destination.branch.name,
    comments: pr.comment_count,
    tasks: pr.task_count,
    updated_on: pr.updated_on,
    url: pr.links.html.href,
  };
}

function detailPullRequest(pr: BbPullRequest) {
  return {
    ...summarizePullRequest(pr),
    description: pr.description ?? "",
    created_on: pr.created_on,
    close_source_branch: pr.close_source_branch,
    reviewers: (pr.reviewers ?? []).map(userSummary),
    participants: (pr.participants ?? []).map((p) => ({
      name: p.user.display_name,
      role: p.role,
      state: p.state ?? (p.approved ? "approved" : "pending"),
    })),
  };
}

function summarizeComment(c: BbComment) {
  return {
    id: c.id,
    author: c.user.display_name,
    created_on: c.created_on,
    text: c.deleted ? "[borrado]" : c.content.raw,
    inline: c.inline ? { path: c.inline.path, line: c.inline.to ?? c.inline.from } : undefined,
    reply_to: c.parent?.id,
    resolved: c.resolution ? true : undefined,
  };
}

/** Path como lo escribe git cuando tiene caracteres no ASCII: entre comillas y en octal. */
export function gitQuote(path: string): string {
  let out = "";
  for (const byte of Buffer.from(path, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (byte >= 0x80 || byte < 0x20) out += "\\" + byte.toString(8).padStart(3, "0");
    else if (ch === '"' || ch === "\\") out += "\\" + ch;
    else out += ch;
  }
  return out;
}

/** Se queda con las secciones del diff unificado de exactamente esos paths. */
export function filterDiff(diff: string, paths: string[]): string {
  const sections = diff.split(/^(?=diff --git )/m);
  return sections
    .filter((section) => {
      if (!section.startsWith("diff --git ")) return false;
      const header = section.slice(0, section.indexOf("\n") === -1 ? undefined : section.indexOf("\n"));
      return paths.some((p) => header.endsWith(` b/${p}`) || header.endsWith(` "b/${gitQuote(p)}"`));
    })
    .join("");
}

export async function currentUser(ctx: ToolContext): Promise<BbUser> {
  return ctx.client.get<BbUser>("/user");
}

export function registerPullRequestTools(ctx: ToolContext): void {
  const { server, client } = ctx;
  const prPath = (ws: string | undefined, repo: string, id: number) =>
    `${repoPath(client, ws, repo)}/pullrequests/${id}`;

  server.registerTool(
    "list_pull_requests",
    {
      title: "Listar pull requests de un repo",
      description: "Lista PRs de un repositorio, por defecto los abiertos, del más reciente al más viejo.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        state: prState.default("OPEN"),
        query: z
          .string()
          .optional()
          .describe('Filtro BBQL adicional, ej. source.branch.name ~ "ABC-123".'),
        limit: limitParam(20),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, state, query, limit }) => {
      const q = query ? `state="${state}" AND (${query})` : `state="${state}"`;
      const prs = await client.paginate<BbPullRequest>(
        `${repoPath(client, workspace, repo)}/pullrequests`,
        { q, sort: "-updated_on" },
        limit,
      );
      return json(prs.map(summarizePullRequest));
    }),
  );

  server.registerTool(
    "list_my_pull_requests",
    {
      title: "Mis pull requests",
      description:
        "PRs abiertos donde soy autora (role=author) o reviewer (role=reviewer). " +
        "Para reviewer sin repo, recorre los repos actualizados más recientemente del workspace.",
      inputSchema: {
        workspace: workspaceParam,
        role: z.enum(["author", "reviewer"]),
        repo: repoParam.optional(),
        repos_to_scan: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(15)
          .describe("Para role=reviewer sin repo: cuántos repos recientes revisar."),
        limit: limitParam(30),
      },
      annotations: READ,
    },
    safe(async ({ workspace, role, repo, repos_to_scan, limit }) => {
      const me = await currentUser(ctx);
      const ws = client.workspace(workspace);
      const field = role === "author" ? "author" : "reviewers";
      const q = `state="OPEN" AND ${field}.uuid="${me.uuid}"`;

      const repos = repo
        ? [repo]
        : role === "author"
          ? null
          : (
              await client.paginate<{ slug: string }>(
                `/repositories/${slug(ws, "Workspace")}`,
                { sort: "-updated_on" },
                repos_to_scan,
              )
            ).map((r) => r.slug);

      if (!repos) {
        const prs = await client.paginate<BbPullRequest>(
          `/workspaces/${slug(ws, "Workspace")}/pullrequests/${encodeURIComponent(me.uuid)}`,
          { state: "OPEN" },
          limit,
        );
        return json(prs.map((pr) => ({ repo: pr.source.repository?.full_name, ...summarizePullRequest(pr) })));
      }

      const perRepo = await Promise.all(
        repos.map(async (slug) => {
          const prs = await client.paginate<BbPullRequest>(
            `${repoPath(client, ws, slug)}/pullrequests`,
            { q },
            limit,
          );
          return prs.map((pr) => ({ repo: slug, ...summarizePullRequest(pr) }));
        }),
      );
      return json(perRepo.flat().slice(0, limit));
    }),
  );

  server.registerTool(
    "get_pull_request",
    {
      title: "Ver pull request",
      description: "Detalle de un PR: descripción (lo que se pidió), ramas, reviewers y estado de cada aprobación.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, id: prId },
      annotations: READ,
    },
    safe(async ({ workspace, repo, id }) => {
      const pr = await client.get<BbPullRequest>(prPath(workspace, repo, id));
      return json(detailPullRequest(pr));
    }),
  );

  server.registerTool(
    "get_pull_request_diff",
    {
      title: "Diff de un pull request",
      description:
        "Resumen de archivos cambiados (diffstat) y el diff unificado. Con paths, devuelve solo esos archivos.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        paths: z.array(z.string()).optional().describe("Limitar el diff a estos archivos."),
        stat_only: z.boolean().default(false).describe("Solo la lista de archivos, sin el diff."),
        max_chars: z.number().int().min(1000).max(200_000).default(40_000),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, id, paths, stat_only, max_chars }) => {
      const base = prPath(workspace, repo, id);
      const stat = await client.paginate<{
        status: string;
        lines_added: number;
        lines_removed: number;
        old?: { path: string } | null;
        new?: { path: string } | null;
      }>(`${base}/diffstat`, {}, 500);
      const files = stat.map((s) => ({
        path: s.new?.path ?? s.old?.path,
        status: s.status,
        added: s.lines_added,
        removed: s.lines_removed,
      }));
      if (stat_only) return json(files);

      const fullDiff = await client.getText(`${base}/diff`);
      const diff = paths?.length ? filterDiff(fullDiff, paths) : fullDiff;
      return text(`${JSON.stringify(files, null, 2)}\n\n${external(`diff del PR #${id}`, truncate(diff, max_chars))}`);
    }),
  );

  server.registerTool(
    "get_pull_request_activity",
    {
      title: "Actividad de un pull request",
      description: "Historial del PR: actualizaciones, aprobaciones, pedidos de cambios y comentarios.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, id: prId, limit: limitParam(50) },
      annotations: READ,
    },
    safe(async ({ workspace, repo, id, limit }) => {
      const events = await client.paginate<Record<string, any>>(
        `${prPath(workspace, repo, id)}/activity`,
        {},
        limit,
      );
      return json(
        events.map((e) => {
          if (e.comment) return { type: "comment", ...summarizeComment(e.comment) };
          if (e.approval) return { type: "approval", by: e.approval.user?.display_name, date: e.approval.date };
          if (e.changes_requested)
            return {
              type: "changes_requested",
              by: e.changes_requested.user?.display_name,
              date: e.changes_requested.date,
            };
          if (e.update)
            return {
              type: "update",
              by: e.update.author?.display_name,
              date: e.update.date,
              state: e.update.state,
              title: e.update.title,
            };
          return { type: Object.keys(e).find((k) => k !== "pull_request") ?? "unknown" };
        }),
      );
    }),
  );

  server.registerTool(
    "list_pull_request_comments",
    {
      title: "Comentarios de un pull request",
      description: "Comentarios generales e inline (con archivo y línea), incluyendo respuestas.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, id: prId, limit: limitParam(100, 1000) },
      annotations: READ,
    },
    safe(async ({ workspace, repo, id, limit }) => {
      const comments = await client.paginate<BbComment>(`${prPath(workspace, repo, id)}/comments`, {}, limit);
      return json(comments.map(summarizeComment));
    }),
  );

  server.registerTool(
    "create_pull_request",
    {
      title: "Crear pull request",
      description:
        "Crea un PR. Sin destination_branch usa la rama principal del repo. " +
        "Los reviewers se pasan por uuid (buscalos con search_members o get_default_reviewers).",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        title: z.string().min(1),
        source_branch: z.string(),
        destination_branch: z.string().optional(),
        description: z.string().optional(),
        reviewer_uuids: z.array(z.string()).optional(),
        close_source_branch: z.boolean().default(false),
      },
      annotations: WRITE,
    },
    safe(async ({ workspace, repo, title, source_branch, destination_branch, description, reviewer_uuids, close_source_branch }) => {
      const pr = await client.post<BbPullRequest>(`${repoPath(client, workspace, repo)}/pullrequests`, {
        title,
        description,
        source: { branch: { name: source_branch } },
        destination: destination_branch ? { branch: { name: destination_branch } } : undefined,
        reviewers: reviewer_uuids?.map((uuid) => ({ uuid })),
        close_source_branch,
      });
      return json(detailPullRequest(pr));
    }),
  );

  server.registerTool(
    "update_pull_request",
    {
      title: "Editar pull request",
      description: "Cambia título, descripción o rama destino de un PR abierto.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        destination_branch: z.string().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, id, title, description, destination_branch }) => {
      if (title === undefined && description === undefined && destination_branch === undefined) {
        return fail("No hay nada para cambiar: pasá title, description o destination_branch.");
      }
      const pr = await client.put<BbPullRequest>(prPath(workspace, repo, id), {
        title,
        description,
        destination: destination_branch ? { branch: { name: destination_branch } } : undefined,
      });
      return json(detailPullRequest(pr));
    }),
  );

  server.registerTool(
    "set_pull_request_reviewers",
    {
      title: "Agregar o quitar reviewers",
      description: "Agrega y/o quita reviewers de un PR por uuid, conservando el resto.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        add_uuids: z.array(z.string()).default([]),
        remove_uuids: z.array(z.string()).default([]),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, id, add_uuids, remove_uuids }) => {
      const path = prPath(workspace, repo, id);
      const current = await client.get<BbPullRequest>(path);
      const uuids = new Set((current.reviewers ?? []).map((r) => r.uuid));
      add_uuids.forEach((u) => uuids.add(u));
      remove_uuids.forEach((u) => uuids.delete(u));
      const pr = await client.put<BbPullRequest>(path, {
        title: current.title,
        reviewers: [...uuids].map((uuid) => ({ uuid })),
      });
      return json({ id: pr.id, reviewers: (pr.reviewers ?? []).map(userSummary) });
    }),
  );

  server.registerTool(
    "comment_pull_request",
    {
      title: "Comentar un pull request",
      description:
        "Agrega un comentario general, inline (path + line del archivo nuevo) o una respuesta (parent_id). Markdown permitido.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        content: z.string().min(1),
        path: z.string().optional().describe("Archivo para comentario inline."),
        line: z.number().int().positive().optional().describe("Línea en la versión nueva del archivo."),
        parent_id: z.number().int().positive().optional().describe("Id del comentario al que se responde."),
      },
      annotations: WRITE,
    },
    safe(async ({ workspace, repo, id, content, path, line, parent_id }) => {
      if (line !== undefined && !path) return fail("Para un comentario inline hace falta path además de line.");
      const comment = await client.post<BbComment>(`${prPath(workspace, repo, id)}/comments`, {
        content: { raw: content },
        inline: path ? { path, to: line } : undefined,
        parent: parent_id ? { id: parent_id } : undefined,
      });
      return json(summarizeComment(comment));
    }),
  );

  server.registerTool(
    "review_pull_request",
    {
      title: "Aprobar o pedir cambios",
      description:
        "unapprove (retirar aprobación), request_changes o remove_request_changes. Para aprobar, usá approve_pull_request.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        action: z.enum(["unapprove", "request_changes", "remove_request_changes"]),
      },
      annotations: WRITE,
    },
    safe(async ({ workspace, repo, id, action }) => {
      const base = prPath(workspace, repo, id);
      if (action === "unapprove") await client.delete(`${base}/approve`);
      if (action === "request_changes") await client.post(`${base}/request-changes`);
      if (action === "remove_request_changes") await client.delete(`${base}/request-changes`);
      return text(`OK: ${action} en PR #${id}.`);
    }),
  );

  server.registerTool(
    "approve_pull_request",
    {
      title: "Aprobar pull request (crítica)",
      description:
        "Aprueba un PR a nombre de la usuaria. Es crítica porque una aprobación puede habilitar un merge " +
        "que dispare un deploy: el cliente le pide confirmación al humano antes de ejecutar.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, id: prId },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, id }) => {
      const path = prPath(workspace, repo, id);
      const pr = await client.get<BbPullRequest>(path);
      return critical(ctx, `aprobar el PR #${id} de ${repo}`, previewPullRequest(pr), async () => {
        await client.post(`${path}/approve`);
        return text(`PR #${id} aprobado.`);
      });
    }),
  );

  server.registerTool(
    "decline_pull_request",
    {
      title: "Declinar pull request (crítica)",
      description:
        "Declina (cierra sin mergear) un PR. El cliente le pide confirmación al humano antes de ejecutar.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        id: prId,
        reason: z.string().optional().describe("Motivo; se deja como comentario antes de declinar."),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, id, reason }) => {
      const path = prPath(workspace, repo, id);
      const pr = await client.get<BbPullRequest>(path);
      const preview = `${previewPullRequest(pr)}\nMotivo: ${reason ? JSON.stringify(reason) : "(sin motivo)"}`;
      return critical(ctx, `declinar el PR #${id} de ${repo}`, preview, async () => {
        if (reason) await client.post(`${path}/comments`, { content: { raw: reason } });
        const declined = await client.post<BbPullRequest>(`${path}/decline`);
        return text(`PR #${id} declinado. Estado: ${declined.state ?? "DECLINED"}.`);
      });
    }),
  );
}

/** Vista previa con los campos externos serializados, así no pueden inyectar líneas. */
function previewPullRequest(pr: BbPullRequest): string {
  const s = summarizePullRequest(pr);
  return [
    `PR #${s.id}: ${JSON.stringify(s.title)}`,
    `Ramas: ${JSON.stringify(s.source)} → ${JSON.stringify(s.destination)}`,
    `Autor: ${JSON.stringify(s.author)} · Estado actual: ${s.state}`,
    s.url,
  ].join("\n");
}
