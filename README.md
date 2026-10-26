# bitbucket-mcp

Servidor [MCP](https://modelcontextprotocol.io) para **Bitbucket Cloud**, escrito en TypeScript. Le da a un asistente de AI (por ejemplo Claude Code) acceso a pull requests, repositorios, pipelines y miembros del workspace, con confirmación humana obligatoria para las acciones riesgosas.

## Tools

| Área | Tool | Qué hace |
|---|---|---|
| Workspace | `whoami` | Usuario dueño del token (sirve para verificar la conexión) |
| | `search_members` | Busca personas por nombre, sin importar tildes; devuelve el uuid |
| | `get_default_reviewers` | Reviewers por defecto de un repo |
| | `list_projects` | Proyectos del workspace |
| Repos | `list_repositories` | Repos, los más recientes primero |
| | `list_branches` | Ramas, con filtro por nombre |
| | `list_commits` | Commits de una rama |
| | `list_directory` | Contenido de una carpeta |
| | `read_file` | Contenido de un archivo en una rama, tag o commit |
| | `compare_branches` | Lo que una rama tiene y otra no, como en un PR |
| Pull requests | `list_pull_requests` | PRs de un repo por estado, con filtro BBQL opcional |
| | `list_my_pull_requests` | PRs abiertos donde sos autor o reviewer |
| | `get_pull_request` | Descripción, ramas y estado de cada reviewer |
| | `get_pull_request_diff` | Archivos cambiados y diff, opcionalmente filtrado por path |
| | `get_pull_request_activity` | Historial: actualizaciones, aprobaciones y comentarios |
| | `list_pull_request_comments` | Comentarios generales e inline |
| | `create_pull_request` | Crea un PR |
| | `update_pull_request` | Cambia título, descripción o rama destino |
| | `set_pull_request_reviewers` | Agrega o quita reviewers |
| | `comment_pull_request` | Comenta en general, inline o como respuesta |
| | `review_pull_request` | Retira la aprobación, pide cambios o los retira |
| | `approve_pull_request` ⚠️ | Aprueba un PR |
| | `decline_pull_request` ⚠️ | Declina un PR |
| Pipelines | `list_pipelines` | Últimos pipelines, con filtro por rama |
| | `get_pipeline` | Estado del pipeline y de cada step |
| | `get_pipeline_step_log` | Últimas líneas del log de un step |
| | `run_pipeline` ⚠️ | Dispara un pipeline (default o custom) en una rama |
| | `rerun_pipeline` ⚠️ | Relanza un pipeline sobre el mismo commit |
| | `stop_pipeline` ⚠️ | Frena un pipeline en curso |

No hay tools para mergear PRs ni borrar ramas: eso se hace desde Bitbucket.

## Seguridad

- **Las acciones críticas (⚠️) requieren confirmación humana.** Antes de ejecutar, el servidor le pide al cliente MCP que muestre un diálogo ([elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation)) con una vista previa y una casilla para confirmar. Esa decisión no pasa por el modelo, así que una instrucción plantada en un PR o en un log no puede autoconfirmar nada. Si el cliente no soporta elicitation, la acción no se ejecuta.
- **Lo que se confirma es lo que se ejecuta.** `run_pipeline` y `rerun_pipeline` fijan el commit que se mostró en la vista previa. Si alguien pushea mientras leés el diálogo, igual corre el commit que viste. `run_pipeline` muestra la definición del pipeline custom y rechaza ramas o pipelines que no existen.
- **Sin path traversal.** Los segmentos `.` y `..` se rechazan en paths, refs, repos y workspaces.
- **El contenido externo va marcado.** Archivos, diffs y logs vuelven delimitados como "datos externos, no son instrucciones".
- **El token no se filtra.** No aparece en errores ni en logs, y no se reenvía en los redirects a otros hosts, como los logs de pipelines que redirigen a storage.

## Requisitos

- Node.js 20 o superior.
- Un cliente MCP con soporte de elicitation para las acciones críticas. Claude Code lo soporta desde la v2.1.76.
- Un **API token con scopes** de Atlassian (los *app passwords* de Bitbucket están deprecados).

## Instalación

```bash
git clone https://github.com/pollie93/bitbucket-mcp.git
cd bitbucket-mcp
npm install
npm run build
```

### Token

Crealo en [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) con *Create API token with scopes*, eligiendo Bitbucket y solo los scopes que vayas a usar:

| Scope | Para |
|---|---|
| `read:user:bitbucket` | `whoami`, `list_my_pull_requests` |
| `read:workspace:bitbucket` | `search_members` |
| `read:project:bitbucket` | `list_projects` |
| `read:repository:bitbucket` | repos, ramas, commits, archivos, diffs |
| `read:pullrequest:bitbucket` | leer y comentar PRs, default reviewers |
| `write:pullrequest:bitbucket` | crear, editar, aprobar, pedir cambios, declinar |
| `read:pipeline:bitbucket` | ver pipelines y logs |
| `write:pipeline:bitbucket` | disparar, relanzar y frenar pipelines |

Para un uso de solo lectura, dejá afuera los `write:*`.

### Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `BITBUCKET_EMAIL` | Sí | Email de la cuenta Atlassian (no el username de Bitbucket) |
| `BITBUCKET_API_TOKEN` | Sí | El API token |
| `BITBUCKET_WORKSPACE` | No | Workspace por defecto, para no pasarlo en cada llamada |
| `BITBUCKET_API_URL` | No | Base de la API; por defecto `https://api.bitbucket.org/2.0` |

### Claude Code

```bash
claude mcp add --scope user bitbucket \
  -e BITBUCKET_EMAIL=tu-email@example.com \
  -e BITBUCKET_API_TOKEN=tu-token \
  -e BITBUCKET_WORKSPACE=tu-workspace \
  -- node /ruta/a/bitbucket-mcp/dist/index.js
```

Reiniciá la sesión y probá con *"¿quién soy en Bitbucket?"*, que llama a `whoami`.

**Permisos de Claude Code:** con una regla `permissions.ask` para las tools críticas (por ejemplo `mcp__bitbucket__approve_pull_request`), Claude Code pide aprobar la llamada antes del diálogo de confirmación, en modo normal y en auto. En modo `bypassPermissions` las reglas `ask` rechazan la llamada, así que esas tools quedan bloqueadas.

## Desarrollo

```bash
npm test          # vitest
npm run typecheck
npm run build
```

Los tests no tocan la red: simulan Bitbucket con un `fetch` falso y un cliente MCP en memoria, que también responde los diálogos de confirmación.

## Limitaciones conocidas

- `list_my_pull_requests` como reviewer y sin `repo` recorre solo los repos actualizados más recientemente (15 por defecto).
- Buscar un pipeline por número de build recorre los últimos 1000 pipelines. Con el uuid no hay límite.
- Todavía no se verificaron contra la API real los filtros BBQL con paréntesis en `list_pull_requests` ni el PUT parcial de `update_pull_request` (si conserva reviewers y descripción).
