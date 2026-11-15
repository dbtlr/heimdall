export type HubCheck = {
  part: string;
  state: 'ok' | 'warning' | 'unknown';
  text: string;
  detail: string;
};
export type HubTable = { title: string; columns: string[]; rows: string[][] };
export type HubStatus = {
  version: string;
  started: string;
  checks: HubCheck[];
  tables: HubTable[];
};
