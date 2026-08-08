export interface PackageBinPolicyResult {
  ok: boolean;
  pkg: string | undefined;
  lock: string | undefined;
  error?: string;
}

export function checkPackageBinPolicy(
  pkgPath: string,
  lockPath: string,
): PackageBinPolicyResult;

export function isPackageBinPolicyOk(
  pkgPath: string,
  lockPath: string,
): boolean;
