// Placeholder for stages.ts

export type StageResult<T> = {
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  warnings: string[];
  data: T;
};
