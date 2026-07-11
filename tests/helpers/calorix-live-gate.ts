import {
  getCalorixProjectRoot,
  getValidatedCalorixExpectedImage,
  type ValidatedCalorixExpectedImage
} from "./calorix-device.js";
import {
  ensureSidecarRunning,
  type SidecarHandle
} from "./sidecar-manager.js";

export interface PreparedCalorixLiveGate {
  projectRoot: string;
  expected: ValidatedCalorixExpectedImage;
  sidecarHandle: SidecarHandle;
}

export async function prepareCalorixLiveGate(options: {
  projectRoot?: string;
  sidecarUrl?: string;
  ensureSidecar?: (url: string) => Promise<SidecarHandle>;
} = {}): Promise<PreparedCalorixLiveGate> {
  const projectRoot = options.projectRoot ?? getCalorixProjectRoot();
  const expected = await getValidatedCalorixExpectedImage(projectRoot);
  const sidecarUrl = options.sidecarUrl ?? process.env["LOCATEANYTHING_SIDECAR_URL"] ?? "http://127.0.0.1:39731";
  const sidecarHandle = await (options.ensureSidecar ?? ensureSidecarRunning)(sidecarUrl);
  return { projectRoot, expected, sidecarHandle };
}
