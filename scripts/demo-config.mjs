export function readDemoConfig(env = process.env) {
  const backendHost = env.DEMO_BACKEND_HOST ?? "127.0.0.1";
  const backendPort = String(env.DEMO_BACKEND_PORT ?? "7357");
  const frontendHost = env.DEMO_FRONTEND_HOST ?? "127.0.0.1";
  const frontendPort = String(env.DEMO_FRONTEND_PORT ?? "5173");

  return {
    apiBase: `http://${backendHost}:${backendPort}`,
    backendHost,
    backendPort,
    backendUrl: `http://${backendHost}:${backendPort}`,
    frontendHost,
    frontendPort,
    frontendUrl: `http://${frontendHost}:${frontendPort}`,
  };
}
