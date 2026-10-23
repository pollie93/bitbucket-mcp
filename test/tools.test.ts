import { describe, expect, it } from "vitest";
import { filterDiff } from "../src/tools/pullrequests.js";
import { lastLines } from "../src/tools/pipelines.js";
import { normalize } from "../src/tools/workspace.js";
import { callText, connect, fakeFetch, pr } from "./helpers.js";

const REPO = "/2.0/repositories/acme/demo-repo";

describe("registro de tools", () => {
  it("expone las tools con sus anotaciones de riesgo", async () => {
    const client = await connect(fakeFetch({}).impl);
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(tools).toHaveLength(29);
    expect(byName.read_file.annotations?.readOnlyHint).toBe(true);
    for (const name of ["approve_pull_request", "decline_pull_request", "run_pipeline", "rerun_pipeline", "stop_pipeline"]) {
      expect(byName[name].annotations?.destructiveHint).toBe(true);
    }
    expect(byName.merge_pull_request).toBeUndefined();
  });
});

describe("pull requests", () => {
  it("get_pull_request devuelve descripción y estado de cada reviewer", async () => {
    const client = await connect(fakeFetch({ [`GET ${REPO}/pullrequests/7`]: () => pr() }).impl);
    const { text } = await callText(client, "get_pull_request", { repo: "demo-repo", id: 7 });
    const data = JSON.parse(text);
    expect(data.description).toBe("Pide agregar filtros en mobile");
    expect(data.participants[0]).toEqual({ name: "José Pérez", role: "REVIEWER", state: "changes_requested" });
  });

  it("list_my_pull_requests como reviewer filtra por mi uuid", async () => {
    const { impl, calls } = fakeFetch({
      "GET /2.0/user": () => ({ uuid: "{me}", display_name: "Usuario Demo" }),
      [`GET ${REPO}/pullrequests`]: () => ({ values: [pr()] }),
    });
    const client = await connect(impl);
    const { text } = await callText(client, "list_my_pull_requests", { role: "reviewer", repo: "demo-repo" });
    const q = calls.find((c) => c.url.pathname.endsWith("/pullrequests"))!.url.searchParams.get("q");
    expect(q).toBe('state="OPEN" AND reviewers.uuid="{me}"');
    expect(JSON.parse(text)[0]).toMatchObject({ repo: "demo-repo", id: 7 });
  });

  it("set_pull_request_reviewers conserva los existentes", async () => {
    const { impl, calls } = fakeFetch({
      [`GET ${REPO}/pullrequests/7`]: () => pr(),
      [`PUT ${REPO}/pullrequests/7`]: (call) => pr({ reviewers: (call.body as any).reviewers }),
    });
    const client = await connect(impl);
    await callText(client, "set_pull_request_reviewers", { repo: "demo-repo", id: 7, add_uuids: ["{s}"] });
    const put = calls.find((c) => c.method === "PUT")!;
    expect((put.body as any).reviewers).toEqual([{ uuid: "{j}" }, { uuid: "{s}" }]);
  });

  it("comment_pull_request arma el comentario inline", async () => {
    const { impl, calls } = fakeFetch({
      [`POST ${REPO}/pullrequests/7/comments`]: (call) => ({
        id: 1,
        content: (call.body as any).content,
        user: { uuid: "{me}", display_name: "Usuario Demo" },
        created_on: "2026-10-23",
        inline: (call.body as any).inline,
      }),
    });
    const client = await connect(impl);
    await callText(client, "comment_pull_request", {
      repo: "demo-repo",
      id: 7,
      content: "¿Esto no va en otro archivo?",
      path: "src/styles/main.css",
      line: 12,
    });
    expect(calls[0].body).toEqual({
      content: { raw: "¿Esto no va en otro archivo?" },
      inline: { path: "src/styles/main.css", to: 12 },
    });
  });

  it("filterDiff deja solo los archivos pedidos", () => {
    const diff = "diff --git a/a.css b/a.css\n+uno\ndiff --git a/b.jsonc b/b.jsonc\n+dos\n";
    expect(filterDiff(diff, ["b.jsonc"])).toBe("diff --git a/b.jsonc b/b.jsonc\n+dos\n");
  });
});

describe("pipelines", () => {
  it("lastLines recorta al final del log", () => {
    expect(lastLines("a\nb\nc\nd", 2)).toBe("[… 2 líneas anteriores]\nc\nd");
  });
});

describe("workspace", () => {
  it("search_members ignora tildes y mayúsculas", async () => {
    const { impl } = fakeFetch({
      "GET /2.0/workspaces/acme/members": () => ({
        values: [
          { user: { uuid: "{j}", display_name: "José Pérez" } },
          { user: { uuid: "{s}", display_name: "Ana Gómez" } },
        ],
      }),
    });
    const client = await connect(impl);
    const { text } = await callText(client, "search_members", { query: "jose" });
    expect(JSON.parse(text)).toEqual([{ uuid: "{j}", name: "José Pérez" }]);
  });

  it("normalize saca tildes", () => {
    expect(normalize("JOSÉ")).toBe("jose");
  });
});
