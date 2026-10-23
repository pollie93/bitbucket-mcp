import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createServer } from "../src/server.js";
import type { Config } from "../src/config.js";

export const config: Config = {
  email: "user@example.com",
  apiToken: "token-123",
  defaultWorkspace: "acme",
  baseUrl: "https://api.bitbucket.org/2.0",
};

export interface Call {
  method: string;
  url: URL;
  body?: unknown;
  headers: Record<string, string>;
}

type Route = (call: Call) => unknown | Response;

/** Fake de la red: responde según "METHOD /path" y registra cada llamada. */
export function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
    const result = route(call);
    if (result instanceof Response) return result;
    return new Response(typeof result === "string" ? result : JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

export interface ElicitCall {
  message: string;
}

/** Simula al humano respondiendo el diálogo de confirmación del cliente MCP. */
export type Elicit = (req: ElicitCall) => { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export async function connect(
  fetchImpl: typeof fetch,
  opts: { elicit?: Elicit; serverConfig?: Config } = {},
) {
  const server = createServer(opts.serverConfig ?? config, fetchImpl);
  const client = new Client(
    { name: "test", version: "0.0.0" },
    { capabilities: opts.elicit ? { elicitation: { form: {} } } : {} },
  );
  if (opts.elicit) {
    const elicit = opts.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (req) =>
      elicit({ message: (req.params as { message: string }).message }),
    );
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

export async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  return { text: res.content.map((c) => c.text).join("\n"), isError: res.isError ?? false };
}

export function pr(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    title: "ABC-123 cambio de prueba",
    description: "Pide agregar filtros en mobile",
    state: "OPEN",
    author: { uuid: "{a}", display_name: "Usuario Demo" },
    source: { branch: { name: "feature/ABC-123_demo" } },
    destination: { branch: { name: "main" } },
    reviewers: [{ uuid: "{j}", display_name: "José Pérez" }],
    participants: [
      { user: { uuid: "{j}", display_name: "José Pérez" }, role: "REVIEWER", approved: false, state: "changes_requested" },
    ],
    comment_count: 2,
    task_count: 0,
    created_on: "2026-10-20T10:00:00Z",
    updated_on: "2026-10-23T10:00:00Z",
    links: { html: { href: "https://bitbucket.org/acme/demo-repo/pull-requests/7" } },
    ...overrides,
  };
}
