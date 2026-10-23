import type { Config } from "./config.js";

export class BitbucketError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Bitbucket ${status} en ${path}: ${extractMessage(body)}`);
    this.name = "BitbucketError";
  }
}

function extractMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; detail?: string } };
    const { message, detail } = parsed.error ?? {};
    if (message) return detail ? `${message} (${detail})` : message;
  } catch {
    // body no es JSON: se devuelve tal cual
  }
  return body.slice(0, 500) || "sin detalle";
}

interface Page<T> {
  values: T[];
  next?: string;
}

type Query = Record<string, string | number | boolean | undefined>;

export class BitbucketClient {
  private readonly authHeader: string;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.authHeader =
      "Basic " + Buffer.from(`${config.email}:${config.apiToken}`).toString("base64");
  }

  workspace(explicit?: string): string {
    const ws = explicit ?? this.config.defaultWorkspace;
    if (!ws) {
      throw new Error("Falta el workspace: pasalo como parámetro o configurá BITBUCKET_WORKSPACE.");
    }
    return ws;
  }

  async get<T>(path: string, query?: Query): Promise<T> {
    const res = await this.request("GET", path, { query });
    return (await res.json()) as T;
  }

  async getText(path: string, query?: Query): Promise<string> {
    const res = await this.request("GET", path, { query });
    return res.text();
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.request("POST", path, { body });
    return parseOptionalJson<T>(res);
  }

  async put<T>(path: string, body: unknown): Promise<T> {
    const res = await this.request("PUT", path, { body });
    return parseOptionalJson<T>(res);
  }

  async delete(path: string): Promise<void> {
    await this.request("DELETE", path, {});
  }

  /** Recorre la paginación de Bitbucket hasta juntar `limit` elementos. */
  async paginate<T>(path: string, query: Query = {}, limit = 50): Promise<T[]> {
    return this.paginateWhere<T>(path, query, limit, () => true, limit);
  }

  /**
   * Como paginate, pero filtrando del lado del cliente: sigue pidiendo páginas
   * hasta juntar `limit` coincidencias o revisar `maxScanned` elementos.
   */
  async paginateWhere<T>(
    path: string,
    query: Query,
    limit: number,
    predicate: (item: T) => boolean,
    maxScanned: number,
  ): Promise<T[]> {
    const items: T[] = [];
    let scanned = 0;
    let url: string | undefined = this.buildUrl(path, { pagelen: Math.min(maxScanned, 50), ...query });
    while (url && items.length < limit && scanned < maxScanned) {
      const res = await this.request("GET", url, {});
      const page = (await res.json()) as Page<T>;
      scanned += page.values.length;
      items.push(...page.values.filter(predicate));
      url = page.next;
    }
    return items.slice(0, limit);
  }

  private buildUrl(path: string, query?: Query): string {
    if (!path.startsWith("http")) assertNoDotSegments(path);
    const url = new URL(path.startsWith("http") ? path : this.config.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown },
  ): Promise<Response> {
    const url = this.buildUrl(path, opts.query);
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (!res.ok) {
      throw new BitbucketError(res.status, new URL(url).pathname, await res.text());
    }
    return res;
  }
}

async function parseOptionalJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

const DOT_SEGMENT = /^(\.|%2e){1,2}$/i;

/** `new URL()` resuelve `.` y `..`: se rechazan para no salir del endpoint pedido. */
function assertNoDotSegments(path: string): void {
  if (path.split("?")[0].split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new Error(`Path inválido (contiene "." o ".."): ${path}`);
  }
}

/** Codifica cada segmento de un path de archivo sin escapar las barras. */
export function encodePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Path inválido (contiene "." o ".."): ${path}`);
  }
  return segments.map(encodeURIComponent).join("/");
}
