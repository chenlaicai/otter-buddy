import "./src/diagnostics/error-projection.mjs";
import { planPermissions, checkPermissions } from "./src/diagnostics/permission-plan.mjs";
export const permissions = Object.freeze({ plan: planPermissions, check: checkPermissions });
