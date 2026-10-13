import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  getEvents,
  getHistory,
  getSnapshot,
  recoverEnrollment,
  registerCluster,
  registerWorkspace,
  updateProfile,
  workspaces,
} from "../../actions/clusters";
import { operatorMiddleware } from "../../middlewares/operator";
import {
  clusterSchema,
  eventsSchema,
  historySchema,
  idSchema,
  profileSchema,
  snapshotSchema,
  workspaceSchema,
} from "../../schemas/clusters";

export const getSnapshotFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(snapshotSchema)
  .handler(({ context, data }) => getSnapshot(context.env, data));
export const getHistoryFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(historySchema)
  .handler(({ context, data }) => getHistory(context.env, data));
export const getEventsFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .validator(eventsSchema)
  .handler(({ context, data }) => getEvents(context.env, data));
export const getWorkspacesFn = createServerFn({ method: "GET" })
  .middleware([operatorMiddleware])
  .handler(({ context }) => workspaces(context.env));
export const registerClusterFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(clusterSchema)
  .handler(({ context, data }) => registerCluster(context.env, data));
export const recoverEnrollmentFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(idSchema)
  .handler(({ context, data }) => recoverEnrollment(context.env, data));
export const updateProfileFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(z.strictObject({ clusterId: idSchema, profile: profileSchema }))
  .handler(({ context, data }) =>
    updateProfile(context.env, data.clusterId, data.profile)
  );
export const createWorkspaceFn = createServerFn({ method: "POST" })
  .middleware([operatorMiddleware])
  .validator(workspaceSchema)
  .handler(({ context, data }) => registerWorkspace(context.env, data));
