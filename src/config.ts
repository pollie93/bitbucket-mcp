export interface Config {
  email: string;
  apiToken: string;
  defaultWorkspace?: string;
  baseUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const email = env.BITBUCKET_EMAIL;
  const apiToken = env.BITBUCKET_API_TOKEN;
  if (!email || !apiToken) {
    throw new Error(
      "Faltan BITBUCKET_EMAIL y/o BITBUCKET_API_TOKEN. " +
        "El usuario es el email de la cuenta Atlassian, no el username de Bitbucket.",
    );
  }
  return {
    email,
    apiToken,
    defaultWorkspace: env.BITBUCKET_WORKSPACE || undefined,
    baseUrl: (env.BITBUCKET_API_URL || "https://api.bitbucket.org/2.0").replace(/\/+$/, ""),
  };
}
