import { describe, expect, it } from "vitest";
import { BitbucketClient, BitbucketError, encodePath } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { config, fakeFetch } from "./helpers.js";

describe("BitbucketClient", () => {
  it("autentica con Basic email:token", async () => {
    const { impl, calls } = fakeFetch({ "GET /2.0/user": () => ({ uuid: "{a}" }) });
    await new BitbucketClient(config, impl).get("/user");
    const expected = "Basic " + Buffer.from("user@example.com:token-123").toString("base64");
    expect(calls[0].headers.Authorization).toBe(expected);
  });

  it("sigue la paginación hasta el límite", async () => {
    const page2 = "https://api.bitbucket.org/2.0/items?page=2";
    const { impl, calls } = fakeFetch({
      "GET /2.0/items": (call) =>
        call.url.searchParams.get("page") === "2"
          ? { values: [3, 4, 5] }
          : { values: [1, 2], next: page2 },
    });
    const items = await new BitbucketClient(config, impl).paginate<number>("/items", {}, 4);
    expect(items).toEqual([1, 2, 3, 4]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url.searchParams.get("pagelen")).toBe("4");
  });

  it("convierte errores HTTP en BitbucketError con el mensaje de la API", async () => {
    const { impl } = fakeFetch({
      "GET /2.0/user": () =>
        new Response(JSON.stringify({ error: { message: "Unauthorized", detail: "bad token" } }), { status: 401 }),
    });
    const err = await new BitbucketClient(config, impl).get("/user").catch((e) => e);
    expect(err).toBeInstanceOf(BitbucketError);
    expect(err.status).toBe(401);
    expect(err.message).toContain("Unauthorized (bad token)");
  });

  it("exige workspace si no hay default", () => {
    const client = new BitbucketClient({ ...config, defaultWorkspace: undefined });
    expect(() => client.workspace()).toThrow(/workspace/);
    expect(client.workspace("otro")).toBe("otro");
  });
});

describe("encodePath", () => {
  it("codifica segmentos y conserva las barras", () => {
    expect(encodePath("/docs/mi archivo.md")).toBe("docs/mi%20archivo.md");
  });
});

describe("loadConfig", () => {
  it("falla sin credenciales", () => {
    expect(() => loadConfig({})).toThrow(/BITBUCKET_EMAIL/);
  });

  it("toma workspace y URL opcionales", () => {
    const cfg = loadConfig({ BITBUCKET_EMAIL: "a@b.c", BITBUCKET_API_TOKEN: "t", BITBUCKET_WORKSPACE: "acme" });
    expect(cfg).toMatchObject({ defaultWorkspace: "acme", baseUrl: "https://api.bitbucket.org/2.0" });
  });
});
