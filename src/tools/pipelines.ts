import { z } from "zod";
import { BitbucketError } from "../client.js";
import {
  DESTRUCTIVE,
  READ,
  critical,
  external,
  fail,
  json,
  limitParam,
  ref as encodeRef,
  repoParam,
  repoPath,
  safe,
  text,
  truncate,
  workspaceParam,
  type ToolContext,
} from "./shared.js";

interface BbPipelineTarget {
  type: string;
  ref_type?: string;
  ref_name?: string;
  commit?: { type?: string; hash: string };
  selector?: { type: string; pattern?: string };
}

interface BbPipeline {
  uuid: string;
  build_number: number;
  state: { name: string; result?: { name: string }; stage?: { name: string } };
  target: BbPipelineTarget;
  trigger?: { name: string };
  creator?: { display_name: string };
  created_on: string;
  completed_on?: string;
  duration_in_seconds?: number;
}

interface BbStep {
  uuid: string;
  name?: string;
  state: { name: string; result?: { name: string } };
  started_on?: string;
  completed_on?: string;
}

const MAX_SCANNED = 1000;

const pipelineRef = z
  .union([z.number().int().positive(), z.string().min(1)])
  .describe("Número de build (ej. 42) o uuid del pipeline.");

export function summarizePipeline(p: BbPipeline) {
  return {
    build: p.build_number,
    uuid: p.uuid,
    state: p.state.result?.name ?? p.state.stage?.name ?? p.state.name,
    branch: p.target.ref_name,
    pipeline: p.target.selector?.pattern ?? p.target.selector?.type ?? "default",
    commit: p.target.commit?.hash.slice(0, 12),
    trigger: p.trigger?.name,
    by: p.creator?.display_name,
    created_on: p.created_on,
    duration_s: p.duration_in_seconds,
  };
}

export function lastLines(value: string, lines: number): string {
  const all = value.split("\n");
  return all.length <= lines ? value : `[… ${all.length - lines} líneas anteriores]\n${all.slice(-lines).join("\n")}`;
}

/**
 * Extrae del yml la definición de `pipelines.custom.<name>` por indentación,
 * sin parsear YAML completo. Devuelve null si no existe.
 */
export function customPipelineSection(yml: string, name: string): string | null {
  const lines = yml.split("\n");
  const indent = (line: string) => line.length - line.trimStart().length;
  const customIdx = lines.findIndex((l) => l.trim() === "custom:");
  if (customIdx === -1) return null;
  const customIndent = indent(lines[customIdx]);

  for (let i = customIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (indent(line) <= customIndent) return null;
    const key = line.trim().replace(/^["']|["']?:\s*$/g, "");
    if (line.trim().endsWith(":") && key === name) {
      const own = indent(line);
      let end = i + 1;
      while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > own)) end++;
      return lines.slice(i, end).join("\n").trimEnd();
    }
  }
  return null;
}

export function registerPipelineTools(ctx: ToolContext): void {
  const { server, client } = ctx;
  const pipelinesPath = (ws: string | undefined, repo: string) => `${repoPath(client, ws, repo)}/pipelines`;

  async function findPipeline(ws: string | undefined, repo: string, id: number | string): Promise<BbPipeline> {
    if (typeof id === "string" && !/^\d+$/.test(id)) {
      return client.get<BbPipeline>(`${pipelinesPath(ws, repo)}/${encodeRef(id)}`);
    }
    const build = Number(id);
    const [found] = await client.paginateWhere<BbPipeline>(
      pipelinesPath(ws, repo),
      { sort: "-created_on" },
      1,
      (p) => p.build_number === build,
      MAX_SCANNED,
    );
    if (!found) throw new Error(`No encontré el build #${build} entre los últimos ${MAX_SCANNED} pipelines de ${repo}.`);
    return found;
  }

  async function branchHead(ws: string | undefined, repo: string, branch: string): Promise<string> {
    try {
      const b = await client.get<{ target: { hash: string } }>(
        `${repoPath(client, ws, repo)}/refs/branches/${encodeRef(branch)}`,
      );
      return b.target.hash;
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 404) {
        throw new Error(`La rama ${JSON.stringify(branch)} no existe en ${repo}.`);
      }
      throw err;
    }
  }

  async function pipelinesYml(ws: string | undefined, repo: string, hash: string): Promise<string> {
    try {
      return await client.getText(`${repoPath(client, ws, repo)}/src/${encodeRef(hash)}/bitbucket-pipelines.yml`);
    } catch (err) {
      if (err instanceof BitbucketError && err.status === 404) {
        throw new Error(`No hay bitbucket-pipelines.yml en el commit ${hash.slice(0, 12)} de ${repo}.`);
      }
      throw err;
    }
  }

  server.registerTool(
    "list_pipelines",
    {
      title: "Listar pipelines",
      description: "Últimos pipelines del repo con estado, rama y quién los disparó. branch filtra por rama.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        branch: z.string().optional(),
        limit: limitParam(15, 50),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, branch, limit }) => {
      const pipelines = await client.paginateWhere<BbPipeline>(
        pipelinesPath(workspace, repo),
        { sort: "-created_on" },
        limit,
        (p) => !branch || p.target.ref_name === branch,
        branch ? MAX_SCANNED : limit,
      );
      return json(pipelines.map(summarizePipeline));
    }),
  );

  server.registerTool(
    "get_pipeline",
    {
      title: "Ver pipeline",
      description: "Estado de un pipeline y de cada step (sirve para seguirlo mientras corre).",
      inputSchema: { workspace: workspaceParam, repo: repoParam, pipeline: pipelineRef },
      annotations: READ,
    },
    safe(async ({ workspace, repo, pipeline }) => {
      const p = await findPipeline(workspace, repo, pipeline);
      const steps = await client.paginate<BbStep>(
        `${pipelinesPath(workspace, repo)}/${encodeRef(p.uuid)}/steps`,
        {},
        100,
      );
      return json({
        ...summarizePipeline(p),
        steps: steps.map((s) => ({
          uuid: s.uuid,
          name: s.name,
          state: s.state.result?.name ?? s.state.name,
          started_on: s.started_on,
          completed_on: s.completed_on,
        })),
      });
    }),
  );

  server.registerTool(
    "get_pipeline_step_log",
    {
      title: "Log de un step",
      description: "Últimas líneas del log de un step (uuid del step sale de get_pipeline).",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        pipeline: pipelineRef,
        step_uuid: z.string(),
        tail_lines: z.number().int().min(10).max(5000).default(200),
      },
      annotations: READ,
    },
    safe(async ({ workspace, repo, pipeline, step_uuid, tail_lines }) => {
      const p = await findPipeline(workspace, repo, pipeline);
      const log = await client.getText(
        `${pipelinesPath(workspace, repo)}/${encodeRef(p.uuid)}/steps/${encodeRef(step_uuid)}/log`,
      );
      return text(external(`log del build #${p.build_number}`, truncate(lastLines(log, tail_lines), 100_000)));
    }),
  );

  server.registerTool(
    "run_pipeline",
    {
      title: "Disparar pipeline (crítica)",
      description:
        "Dispara un pipeline en el commit actual de una rama; con custom_pipeline corre uno manual " +
        "(ej. un deploy). Puede desplegar a producción: el cliente le muestra al humano el commit y " +
        "la definición del pipeline y pide confirmación. Se ejecuta exactamente ese commit.",
      inputSchema: {
        workspace: workspaceParam,
        repo: repoParam,
        branch: z.string(),
        custom_pipeline: z.string().optional().describe("Nombre bajo pipelines.custom en el yml."),
      },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, branch, custom_pipeline }) => {
      const hash = await branchHead(workspace, repo, branch);
      const yml = await pipelinesYml(workspace, repo, hash);
      let definition: string;
      if (custom_pipeline) {
        const section = customPipelineSection(yml, custom_pipeline);
        if (!section) {
          return fail(`El pipeline custom ${JSON.stringify(custom_pipeline)} no está en el bitbucket-pipelines.yml de ${branch}.`);
        }
        definition = section;
      } else {
        definition = truncate(yml, 12_000);
      }

      const preview = [
        `Repo: ${repo} · Rama: ${JSON.stringify(branch)} · Commit: ${hash.slice(0, 12)}`,
        `Pipeline: ${custom_pipeline ? JSON.stringify(custom_pipeline) : "(el default de la rama)"}`,
        "",
        external("definición en bitbucket-pipelines.yml", definition),
      ].join("\n");

      return critical(ctx, `disparar un pipeline en ${repo}`, preview, async () => {
        const p = await client.post<BbPipeline>(pipelinesPath(workspace, repo), {
          target: {
            type: "pipeline_ref_target",
            ref_type: "branch",
            ref_name: branch,
            commit: { type: "commit", hash },
            selector: custom_pipeline ? { type: "custom", pattern: custom_pipeline } : undefined,
          },
        });
        return json(summarizePipeline(p));
      });
    }),
  );

  server.registerTool(
    "rerun_pipeline",
    {
      title: "Relanzar pipeline (crítica)",
      description:
        "Vuelve a correr un pipeline sobre el MISMO commit, rama y selector del original. Puede desplegar " +
        "a producción: el cliente pide confirmación al humano.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, pipeline: pipelineRef },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, pipeline }) => {
      const original = await findPipeline(workspace, repo, pipeline);
      const { ref_type, ref_name, commit, selector } = original.target;
      if (ref_type !== "branch" || !ref_name || !commit?.hash) {
        return fail("Solo se pueden relanzar pipelines disparados sobre una rama con commit conocido.");
      }
      const preview = `Se relanzaría sobre el mismo commit:\n${JSON.stringify(summarizePipeline(original), null, 2)}`;
      return critical(ctx, `relanzar el build #${original.build_number} de ${repo}`, preview, async () => {
        const p = await client.post<BbPipeline>(pipelinesPath(workspace, repo), {
          target: {
            type: "pipeline_ref_target",
            ref_type: "branch",
            ref_name,
            commit: { type: "commit", hash: commit.hash },
            selector,
          },
        });
        return json(summarizePipeline(p));
      });
    }),
  );

  server.registerTool(
    "stop_pipeline",
    {
      title: "Frenar pipeline (crítica)",
      description: "Frena un pipeline en curso. El cliente pide confirmación al humano.",
      inputSchema: { workspace: workspaceParam, repo: repoParam, pipeline: pipelineRef },
      annotations: DESTRUCTIVE,
    },
    safe(async ({ workspace, repo, pipeline }) => {
      const p = await findPipeline(workspace, repo, pipeline);
      const preview = `Se frenaría:\n${JSON.stringify(summarizePipeline(p), null, 2)}`;
      return critical(ctx, `frenar el build #${p.build_number} de ${repo}`, preview, async () => {
        await client.post(`${pipelinesPath(workspace, repo)}/${encodeRef(p.uuid)}/stopPipeline`);
        return text(`Pipeline #${p.build_number} frenado.`);
      });
    }),
  );
}
