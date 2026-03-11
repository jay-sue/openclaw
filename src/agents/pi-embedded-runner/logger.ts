/**
 * pi-embedded-runner 子系统日志：agent/embedded，用于运行、压缩、认证、overflow 等诊断。
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const log = createSubsystemLogger("agent/embedded");
