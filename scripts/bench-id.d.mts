export interface ResultIdEnv {
  gpu: string;
  ua: string;
  backend: string;
}
export function hash8(text: string): string;
export function computeResultId(env: ResultIdEnv, day: string): string;
