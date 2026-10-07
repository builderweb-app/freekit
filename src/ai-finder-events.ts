export type AIFinderStatusPhase =
  | 'running'
  | 'attempt'
  | 'success'
  | 'failed'
  | 'timeout'
  | 'cancelled';

export interface AIFinderStatus {
  id: string;
  providerId: string;
  providerName: string;
  phase: AIFinderStatusPhase;
  attempt?: number;
  maxAttempts?: number;
  selectors?: string[];
  message?: string;
}

type StatusListener = (status: AIFinderStatus) => void;

let listener: StatusListener | undefined;

export function setAIFinderStatusListener(next: StatusListener | undefined): void {
  listener = next;
}

export function publishAIFinderStatus(status: AIFinderStatus): void {
  listener?.(status);
}
