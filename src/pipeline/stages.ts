export interface StageResult<T> {
  name: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  warnings: string[];
  data: T;
}

export function runStage<T>(
  name: string,
  fn: () => Promise<T>,
  warnings: string[] = []
): Promise<StageResult<T>> {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  return fn().then(data => ({
    name,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    warnings,
    data
  }));
}
