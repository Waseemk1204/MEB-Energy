/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the backend lives. Defaults to localhost:3000 in development. */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
