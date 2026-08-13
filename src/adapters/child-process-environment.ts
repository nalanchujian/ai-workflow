const INHERITED_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'CODEX_HOME',
] as const;

/** Supplies only runtime prerequisites; tokens may enter only through an explicit MCP descriptor. */
export function minimalChildEnvironment(explicit: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of INHERITED_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(explicit)) {
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}
