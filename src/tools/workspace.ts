import { z } from "zod";
import { currentUser } from "./pullrequests.js";
import { READ, json, limitParam, repoParam, repoPath, safe, slug, userSummary, workspaceParam, type BbUser, type ToolContext } from "./shared.js";

/** Minúsculas y sin tildes, para buscar "jose" y encontrar "José". */
export function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function registerWorkspaceTools(ctx: ToolContext): void {
  const { server, client } = ctx;

  server.registerTool(
    "whoami",
    {
      title: "Usuario autenticado",
      description: "Devuelve el usuario dueño del token (uuid, nombre). Sirve para verificar la conexión.",
      inputSchema: {},
      annotations: READ,
    },
    safe(async () => json(userSummary(await currentUser(ctx)))),
  );

  server.registerTool(
    "search_members",
    {
      title: "Buscar miembros del workspace",
      description:
        "Busca personas del workspace por nombre o nickname (sin importar tildes). " +
        "Devuelve el uuid que se usa para asignar reviewers.",
      inputSchema: {
        workspace: workspaceParam,
        query: z.string().min(1),
        limit: limitParam(10, 50),
      },
      annotations: READ,
    },
    safe(async ({ workspace, query, limit }) => {
      const members = await client.paginate<{ user: BbUser }>(
        `/workspaces/${slug(client.workspace(workspace), "Workspace")}/members`,
        {},
        1000,
      );
      const needle = normalize(query);
      const matches = members
        .map((m) => m.user)
        .filter((u) => normalize(`${u.display_name} ${u.nickname ?? ""}`).includes(needle))
        .slice(0, limit);
      return json(matches.map(userSummary));
    }),
  );

  server.registerTool(
    "get_default_reviewers",
    {
      title: "Reviewers por defecto",
      description: "Reviewers por defecto del repo (propios y heredados del proyecto), con su uuid.",
      inputSchema: { workspace: workspaceParam, repo: repoParam },
      annotations: READ,
    },
    safe(async ({ workspace, repo }) => {
      const reviewers = await client.paginate<{ user: BbUser; reviewer_type: string }>(
        `${repoPath(client, workspace, repo)}/effective-default-reviewers`,
        {},
        100,
      );
      return json(reviewers.map((r) => ({ ...userSummary(r.user), source: r.reviewer_type })));
    }),
  );

  server.registerTool(
    "list_projects",
    {
      title: "Listar proyectos",
      description: "Proyectos del workspace (agrupan repos).",
      inputSchema: { workspace: workspaceParam, limit: limitParam(50) },
      annotations: READ,
    },
    safe(async ({ workspace, limit }) => {
      const projects = await client.paginate<{ key: string; name: string; description?: string; is_private: boolean }>(
        `/workspaces/${slug(client.workspace(workspace), "Workspace")}/projects`,
        {},
        limit,
      );
      return json(projects.map((p) => ({ key: p.key, name: p.name, private: p.is_private })));
    }),
  );
}
