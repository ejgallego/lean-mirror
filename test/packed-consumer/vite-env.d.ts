/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LEAN_BACKEND_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
