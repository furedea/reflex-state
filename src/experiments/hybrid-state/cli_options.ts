export interface CliOptions {
  readonly config?: string;
  readonly out: string;
  readonly input?: string;
  readonly session?: string;
  readonly leaf?: string;
  readonly case?: string;
  readonly labels?: string;
  readonly recorded?: string;
  readonly freeze?: string;
  readonly live: boolean;
}
