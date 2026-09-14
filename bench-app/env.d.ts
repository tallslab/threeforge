/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `owner/repo` of the GitHub repository that ingests results (set by the Pages workflow). */
  readonly VITE_FORGE_REPO?: string;
}
